import { afterEach, describe, expect, mock, test } from "bun:test"
import {
  type EmbeddingModel,
  type EmbeddingModelResult,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  SixbHost,
} from "@sixb/core"
import { getAgentTurnIndexing } from "@sixb/core/internal/agents"
import { createTestAgentExecution } from "@sixb/core/testing"
import { TurnIndexingWorker } from "../src/turn-indexing-worker"

const alice = { type: "user", id: "usr_alice" } as const
const workers: TurnIndexingWorker[] = []

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()))
})

function fixture() {
  const storage = new InMemoryStorage()
  const queues = new InMemoryQueues()
  const embed = mock(
    async (input: { readonly texts: readonly string[] }): Promise<EmbeddingModelResult> => ({
      vectors: input.texts.map(() => [1, 0]),
      usage: { inputTokens: 10 },
    })
  )
  const model: EmbeddingModel = {
    providerId: "test",
    modelId: "embedding",
    definition: { kind: "embedding", providerId: "test", modelId: "embedding", dimensions: 2 },
    embed,
  }
  const host = new SixbHost({
    id: "turn-indexing",
    ontology: [],
    models: { embedding: [model] },
    storage,
    queues,
    broker: new InMemoryBroker(),
    blobStorage: new InMemoryBlobStorage(),
    lakeStorage: new InMemoryLakeStorage(),
  })

  /** Each delivery's outcome, as the worker settles it with the queue. */
  const settled: { readonly outcome: "completed" | "retried"; readonly availableAt?: string }[] = []
  let next: (() => void) | undefined
  const lane = queues.turnIndexing
  const complete = lane.complete.bind(lane)
  const retry = lane.retry.bind(lane)
  lane.complete = async (params) => {
    await complete(params)
    settled.push({ outcome: "completed" })
    next?.()
  }
  lane.retry = async (params) => {
    await retry(params)
    settled.push({
      outcome: "retried",
      ...(params.availableAt ? { availableAt: params.availableAt } : {}),
    })
    next?.()
  }
  const settlement = () =>
    new Promise<void>((resolve) => {
      next = resolve
    })

  const conversation = async () => {
    const agents = storage.agents
    await agents.threads.create({ id: "thr_1", projectId: host.id, ownerPrincipal: alice })
    await agents.messages.append({
      id: "msg_q",
      projectId: host.id,
      threadId: "thr_1",
      runId: null,
      role: "user",
      authorPrincipal: alice,
      parts: [{ type: "text", text: "Which deals slipped?" }],
    })
    const executionId = await createTestAgentExecution(storage, {
      projectId: host.id,
      runId: "run_1",
      requestedBy: alice,
    })
    await agents.runs.create({
      id: "run_1",
      projectId: host.id,
      executionId,
      threadId: "thr_1",
      triggerMessageId: "msg_q",
      spec: { model: { provider: "test", modelId: "large" } },
    })
    await agents.runs.start({
      id: "run_1",
      projectId: host.id,
      execution: { token: "exec_1", queueLeaseExpiresAt: new Date(Date.now() + 60_000) },
    })
    await agents.messages.append({
      id: "msg_a",
      projectId: host.id,
      threadId: "thr_1",
      runId: "run_1",
      role: "assistant",
      parts: [{ type: "text", text: "Acme slipped." }],
    })
    await agents.runs.finish({
      id: "run_1",
      projectId: host.id,
      executionToken: "exec_1",
      status: "succeeded",
    })
  }

  const start = async () => {
    const worker = new TurnIndexingWorker(host, getAgentTurnIndexing(host)!)
    workers.push(worker)
    await worker.start()
  }

  return { host, storage, embed, settled, settlement, conversation, start }
}

describe("TurnIndexingWorker", () => {
  test("indexes the conversation a job names", async () => {
    const f = fixture()
    await f.conversation()
    const settled = f.settlement()

    await getAgentTurnIndexing(f.host)!.request("thr_1")
    await f.start()
    await settled

    expect(f.settled).toEqual([{ outcome: "completed" }])
    const vectors = await f.storage.agents.turnVectors.list({
      projectId: f.host.id,
      threadId: "thr_1",
    })
    expect(vectors.map((vector) => vector.text)).toEqual([
      "Request: Which deals slipped?\n\nAnswer: Acme slipped.",
    ])
  })

  test("comes back when the project's AI limit resets, not before", async () => {
    // Guard proof: drop the AgentTurnIndexingDeferred branch from onExecutionError; the job comes
    // back after the first backoff, a minute from now, instead of at the limit's reset.
    const f = fixture()
    await f.conversation()
    await f.storage.aiLimits.createPolicy({
      id: "tokens",
      projectId: f.host.id,
      subject: { type: "project" },
      limit: { meter: "tokens.total", amount: 1 },
    })
    const settled = f.settlement()

    await getAgentTurnIndexing(f.host)!.request("thr_1")
    await f.start()
    await settled

    expect(f.embed).not.toHaveBeenCalled()
    expect(f.settled).toMatchObject([{ outcome: "retried" }])
    const [status] = await f.storage.aiLimits.listPolicyStatuses({ projectId: f.host.id })
    expect(Date.parse(f.settled[0]!.availableAt!)).toBeGreaterThanOrEqual(
      status!.period.resetAt.getTime()
    )
  })
})
