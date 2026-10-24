import { describe, expect, test } from "bun:test"
import { SixbHost } from "../src"
import type { InMemoryStorage } from "../src/storage"
import { createTestAgentExecution, createTestSixb } from "../src/testing"
import { testLanguageModel } from "./helpers/language-model"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const projectId = "agent-run-accounting"
const at = new Date("2026-10-24T09:00:00.000Z")
const lease = () => ({ token: "delivery-1", queueLeaseExpiresAt: new Date(Date.now() + 60_000) })

function setup() {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({
    id: projectId,
    ontology: [],
    models: { language: [testLanguageModel()] },
    ...deps,
  })
  return { sixb: createTestSixb(host), storage: deps.storage }
}

/** One model call on an execution, priced by its provider. */
async function spend(
  storage: InMemoryStorage,
  executionId: string,
  id: string,
  input: { readonly tokens: readonly [number, number]; readonly nanos: string }
) {
  const { record } = await storage.aiUsage.recordModelCall({
    id: `usage_${id}`,
    projectId,
    executionId,
    attempt: 1,
    callId: `call_${id}`,
    requesterGroupIds: [],
    providerId: "test",
    requestedModelId: "test-model",
    responseId: `response_${id}`,
    usage: { inputTokens: input.tokens[0], outputTokens: input.tokens[1] },
    occurredAt: at,
  })
  await storage.aiCosts.recordModelCallCost({
    status: "rated",
    projectId,
    usageRecordId: record.id,
    billingIdentity: { providerId: "test", modelId: "test-model" },
    pricingContext: {},
    money: { currency: "USD", amountNanos: input.nanos },
    components: [],
    priceSource: {
      sourceId: "provider-reported",
      sourceEntryId: `response_${id}`,
      sourceVersion: "v1",
      observedAt: at,
    },
    ratedAt: at,
  })
}

/** A child the turn spawned, with its own execution below the turn's. */
async function spawnChild(
  storage: InMemoryStorage,
  turn: { readonly id: string; readonly executionId: string },
  key: string
) {
  const executionId = await createTestAgentExecution(storage, {
    projectId,
    runId: `${turn.id}_${key}`,
    sourceExecutionId: turn.executionId,
  })
  const child = await storage.agents.runs.createSubagent({
    id: `${turn.id}_${key}`,
    projectId,
    executionId,
    parentRunId: turn.id,
    parentExecutionToken: "delivery-1",
    spawnKey: key,
    spec: {
      model: { provider: "test", modelId: "test-model" },
      task: `Look into ${key}.`,
      toolNames: [],
      maxSteps: 5,
    },
    thread: { id: `${turn.id}_${key}_thread`, create: true },
    trigger: { id: `${turn.id}_${key}_task`, parts: [{ type: "text", text: `Look into ${key}.` }] },
    maxActiveChildren: 4,
  })
  return { ...child, executionId }
}

/** An action a tool call ran, below the execution that called it. */
async function runAction(storage: InMemoryStorage, parentId: string, runId: string) {
  const parent = await storage.executions.getById({ projectId, id: parentId })
  if (!parent) throw new Error(`Expected execution '${parentId}'.`)

  const execution = await storage.executions.create({
    id: `execution_${runId}`,
    projectId,
    requesterGroupIds: parent.requesterGroupIds,
    ...(parent.requestedBy === undefined ? {} : { requestedBy: parent.requestedBy }),
    executor: { type: "primitive", kind: "action", runId },
    source: { type: "execution", executionId: parent.id },
    correlationId: parent.correlationId,
    authorizationRef: {
      type: "trustedPrimitive",
      primitive: { kind: "action", id: "markPaid", runId },
    },
  })
  return execution.id
}

function usd(nanos: string, ratedCallCount: number) {
  return {
    amounts: [{ currency: "USD", amountNanos: nanos }],
    ratedCallCount,
    unpriceableCallCount: 0,
    unvaluedCallCount: 0,
  }
}

describe("a turn's usage and cost", () => {
  test("add its children's, still at work or failed, and what its tools ran", async () => {
    // Removal proof: read accounting for `run.executionId` alone in `attachRunViews`; the turn
    // shows its own 100 + 50 tokens and $0.03.
    const { sixb, storage } = setup()
    const thread = await sixb.agent.threads.create({})
    const { run: turn } = await sixb.agent.runs.request({ threadId: thread.id, text: "Compare" })
    await storage.agents.runs.start({ projectId, id: turn.id, execution: lease() })

    const running = await spawnChild(storage, turn, "invoices")
    await storage.agents.runs.start({ projectId, id: running.id, execution: lease() })
    const failed = await spawnChild(storage, turn, "payroll")
    await storage.agents.runs.finishQueued({ projectId, id: failed.id, status: "failed" })
    const action = await runAction(storage, running.executionId, "act_tool")

    await spend(storage, turn.executionId, "turn", { tokens: [100, 50], nanos: "30000000" })
    await spend(storage, running.executionId, "running", { tokens: [20, 10], nanos: "5000000" })
    await spend(storage, failed.executionId, "failed", { tokens: [10, 5], nanos: "1000000" })
    await spend(storage, action, "tool", { tokens: [4, 1], nanos: "2000000" })

    // The routing question is asked on the request, before the turn exists: it stays out.
    const request = await storage.executions.getById({ projectId, id: turn.executionId })
    if (request?.source.type !== "execution") throw new Error("Expected the request execution.")
    await spend(storage, request.source.executionId, "routing", { tokens: [7, 1], nanos: "900" })

    const expected = {
      usage: { inputTokens: 134, outputTokens: 66, totalTokens: 200, reportingStatus: "complete" },
      cost: usd("38000000", 4),
    }
    expect(await sixb.agent.runs.getById(turn.id)).toMatchObject(expected)
    expect((await sixb.agent.runs.listForThread(thread.id))?.runs).toMatchObject([expected])

    // A call that did not report its output leaves its execution without one. The turn keeps
    // the output the others reported, a floor, and says it is partial. Removal proof: sum the
    // summaries with aggregateAiModelCallUsage in addUsageSummaries; the turn loses its output.
    await storage.aiUsage.recordModelCall({
      id: "usage_unreported",
      projectId,
      executionId: running.executionId,
      attempt: 1,
      callId: "call_unreported",
      requesterGroupIds: [],
      providerId: "test",
      requestedModelId: "test-model",
      responseId: "response_unreported",
      usage: { inputTokens: 3 },
      occurredAt: at,
    })
    expect(await sixb.agent.runs.getById(turn.id)).toMatchObject({
      usage: { inputTokens: 137, outputTokens: 56, totalTokens: 193, reportingStatus: "partial" },
      cost: { ...usd("38000000", 4), unvaluedCallCount: 1 },
    })
  })

  test("a retry and a fork's turns keep their own, and the first turn its children's", async () => {
    // Removal proof: walk from the turn's request execution instead of the turn's own; the
    // retry, asked through the same request, counts the failed turn and its child too.
    const { sixb, storage } = setup()
    const thread = await sixb.agent.threads.create({})
    const { run: first } = await sixb.agent.runs.request({ threadId: thread.id, text: "Compare" })
    await storage.agents.runs.start({ projectId, id: first.id, execution: lease() })
    const child = await spawnChild(storage, first, "invoices")
    await spend(storage, first.executionId, "first", { tokens: [100, 50], nanos: "30000000" })
    await spend(storage, child.executionId, "child", { tokens: [20, 10], nanos: "5000000" })
    await storage.agents.runs.finish({
      projectId,
      id: first.id,
      executionToken: "delivery-1",
      status: "failed",
    })

    const { run: retry } = await sixb.agent.runs.retry(first.id)
    await spend(storage, retry.executionId, "retry", { tokens: [60, 30], nanos: "20000000" })

    const fork = await sixb.agent.threads.fork(thread.id)
    const { run: forked } = await sixb.agent.runs.request({ threadId: fork.id, text: "Go on" })
    await spend(storage, forked.executionId, "forked", { tokens: [8, 2], nanos: "3000000" })

    expect(await sixb.agent.runs.getById(first.id)).toMatchObject({
      usage: { totalTokens: 180 },
      cost: usd("35000000", 2),
    })
    expect(await sixb.agent.runs.getById(retry.id)).toMatchObject({
      usage: { totalTokens: 90 },
      cost: usd("20000000", 1),
    })
    expect(await sixb.agent.runs.getById(forked.id)).toMatchObject({
      usage: { totalTokens: 10 },
      cost: usd("3000000", 1),
    })
    expect((await sixb.agent.runs.listForThread(fork.id))?.runs).toHaveLength(1)
  })
})
