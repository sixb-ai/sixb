import { describe, expect, test } from "bun:test"
import type { LanguageModel } from "@sixb/core"
import {
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  SixbHost,
} from "@sixb/core"
import {
  agentContextBytesPerToken,
  createAgentRunExecutionToken,
  estimateAgentContextMessagesTokens,
} from "@sixb/core/internal/agents"
import type { ModelRateCard } from "@sixb/core/models"
import type { AgentMessageRecord, ConversationAgentRunSpec } from "@sixb/core/storage"
import { createTestAgentExecution } from "@sixb/core/testing"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

// What a conversation's context meter reads: what its next request starts from, against the
// limits the worker resolves for the model, and its latest compaction.

const projectId = "agent-thread-context"
const at = (minute: number) => new Date(Date.UTC(2026, 10, 1, 9, minute))

/** Prices that rise ×5 from 100,001 tokens, as Haiku 5.5's do. */
const price = (base: number) => ({
  default: String(base),
  tiers: [{ minTokens: 100_001, price: String(base * 5) }],
})
const tieredCard: ModelRateCard = {
  currency: "USD",
  input: price(1),
  output: price(5),
  cacheReadInput: price(0.1),
  cacheWriteInput: price(1.25),
}

function languageModel(modelId: string, rateCard?: ModelRateCard): LanguageModel {
  return {
    providerId: "test",
    modelId,
    definition: {
      kind: "language",
      providerId: "test",
      modelId,
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      capabilities: {},
    },
    ...(rateCard ? { rateCard } : {}),
    stream: async () => {
      throw new Error("Must not invoke the route test model")
    },
  }
}

function createFixture() {
  const storage = new InMemoryStorage()
  const host = new SixbHost({
    id: projectId,
    ontology: [],
    models: { language: [languageModel("flat"), languageModel("tiered", tieredCard)] },
    storage,
    broker: new InMemoryBroker(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
  })
  const app = createSixbApi(
    new SixbServer({ host, quiet: true, browser: createTestBrowserPolicy() })
  )

  const read = async (threadId: string, query = "") => {
    const response = await app.fetch(
      new Request(`http://localhost/api/agent-threads/${threadId}/context${query}`)
    )
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }

  /**
   * A thread whose latest turn ran on `modelId`: its user message, the run, and the run's answer,
   * after an earlier exchange when asked.
   */
  async function seedTurn(
    threadId: string,
    modelId: string,
    options: {
      readonly answer?: boolean
      readonly earlier?: boolean
      /** The turn's last call read a request it reduced. */
      readonly reduced?: boolean
      readonly reasoning?: ConversationAgentRunSpec["reasoning"]
    } = {}
  ) {
    await storage.agents.threads.create({
      projectId,
      id: threadId,
      ownerPrincipal: { type: "system", id: "system" },
    })
    for (const role of options.earlier ? (["user", "assistant"] as const) : []) {
      await storage.agents.messages.append({
        projectId,
        id: `${threadId}_earlier_${role}`,
        threadId,
        runId: null,
        role,
        parts: [{ type: "text", text: "An earlier exchange." }],
      })
    }
    await storage.agents.messages.append({
      projectId,
      id: `${threadId}_user`,
      threadId,
      runId: null,
      role: "user",
      parts: [{ type: "text", text: "Read the repository." }],
    })

    const runId = `${threadId}_run`
    const token = createAgentRunExecutionToken()
    const executionId = await createTestAgentExecution(storage, {
      projectId,
      runId,
      authority: "inherited",
    })
    await storage.agents.runs.create({
      projectId,
      id: runId,
      executionId,
      threadId,
      triggerMessageId: `${threadId}_user`,
      spec: {
        model: { provider: "test", modelId },
        ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
      },
    })
    await storage.agents.runs.start({
      projectId,
      id: runId,
      execution: { token, queueLeaseExpiresAt: new Date(Date.now() + 60_000) },
    })

    if (options.answer !== false) {
      await storage.agents.messages.append({
        projectId,
        id: `${threadId}_answer`,
        threadId,
        runId,
        role: "assistant",
        parts: [
          { type: "step-start" },
          options.reduced ? { type: "step-start", reducedRequest: true } : { type: "step-start" },
          { type: "text", text: "It holds three packages." },
        ],
      })
    }
    return { runId, executionId, token }
  }

  /** What a thread's stored messages weigh at a model's family rate, as an estimate counts them. */
  async function messagesEstimate(threadId: string, modelId: string): Promise<number> {
    const { messages } = await storage.agents.messages.list({ projectId, threadId, order: "asc" })
    const records: readonly AgentMessageRecord[] = messages
    return estimateAgentContextMessagesTokens(records, agentContextBytesPerToken({ modelId }))
      .tokens
  }

  return { storage, read, seedTurn, messagesEstimate }
}

describe("GET /api/agent-threads/:threadId/context", () => {
  test("measures the last call against the target of the latest turn's model", async () => {
    const { storage, read, seedTurn, messagesEstimate } = createFixture()
    const turn = await seedTurn("thr_tiered", "tiered")
    await storage.aiUsage.recordModelCall({
      id: "usage_first",
      projectId,
      executionId: turn.executionId,
      attempt: 1,
      callId: "call_first",
      requesterGroupIds: [],
      providerId: "test",
      requestedModelId: "tiered",
      responseId: "response_first",
      usage: { inputTokens: 30_000, outputTokens: 400, cacheReadInputTokens: 0 },
      occurredAt: at(1),
    })
    await storage.aiUsage.recordModelCall({
      id: "usage_last",
      projectId,
      executionId: turn.executionId,
      attempt: 1,
      callId: "call_last",
      requesterGroupIds: [],
      providerId: "test",
      requestedModelId: "tiered",
      responseId: "response_last",
      usage: { inputTokens: 38_000, outputTokens: 1_200, cacheReadInputTokens: 35_000 },
      occurredAt: at(2),
    })

    // Removal proof: resolve the default model instead of the latest turn's; the target becomes
    // the flat model's window.
    const { status, body } = await read("thr_tiered")
    expect(status).toBe(200)
    expect(body).toEqual({
      model: { provider: "test", modelId: "tiered" },
      windowTokens: 1_000_000,
      limitTokens: 1_000_000 - 16_384,
      target: {
        tokens: 100_000,
        limit: "price-tier",
        tier: { fromTokens: 100_001, priceRatio: 5 },
      },
      // The answer the last call wrote joins what the next request reads.
      usedTokens: 39_200,
      lastCall: {
        inputTokens: 38_000,
        outputTokens: 1_200,
        cacheReadInputTokens: 35_000,
        occurredAt: at(2).toISOString(),
      },
    })

    // Measured against another model, the same conversation keeps its window as the target, and
    // what it uses is estimated: another model's counts say nothing of this one's tokenizer.
    // Removal proof: anchor on the last call whatever its model; the flat model reads 39,200.
    const flat = await read("thr_tiered", "?provider=test&modelId=flat")
    expect(flat.body).toMatchObject({
      model: { provider: "test", modelId: "flat" },
      target: { tokens: 1_000_000 - 16_384, limit: "window" },
      usedTokens: await messagesEstimate("thr_tiered", "flat"),
    })
    expect(flat.body.target).not.toHaveProperty("tier")
  })

  // Removal proof: drop the reduced-request check from `matchingAgentUsageAnchor`; the meter
  // reads a call that saw less than the stored steps replay.
  test("a last call whose request the turn reduced is not what the next request weighs", async () => {
    const { storage, read, seedTurn, messagesEstimate } = createFixture()
    const turn = await seedTurn("thr_reduced", "tiered", { reduced: true })
    await storage.aiUsage.recordModelCall({
      id: "usage_reduced",
      projectId,
      executionId: turn.executionId,
      attempt: 1,
      callId: "call_reduced",
      requesterGroupIds: [],
      providerId: "test",
      requestedModelId: "tiered",
      responseId: "response_reduced",
      usage: { inputTokens: 60_000, outputTokens: 900, cacheReadInputTokens: 0 },
      occurredAt: at(1),
    })

    const { body } = await read("thr_reduced")
    expect(body.usedTokens).toBe(await messagesEstimate("thr_reduced", "tiered"))
    // The call is still the one the cache share is read from.
    expect(body).toMatchObject({ lastCall: { inputTokens: 60_000 } })
  })

  // Removal proof: resolve the budget without the turn's reasoning; the limit keeps the 16,384
  // reserve while the worker leaves the reasoning budget.
  test("the limit leaves the reserve the latest turn's reasoning budget needs", async () => {
    const { read, seedTurn } = createFixture()
    await seedTurn("thr_reasoning", "flat", { reasoning: { budgetTokens: 20_000 } })

    const { body } = await read("thr_reasoning")
    expect(body).toMatchObject({ limitTokens: 1_000_000 - 20_001 })
  })

  test("a compaction no call followed yet is measured by its own estimate", async () => {
    const { storage, read, seedTurn } = createFixture()
    const turn = await seedTurn("thr_condensed", "tiered", { answer: false, earlier: true })
    await storage.agents.checkpoints.create({
      projectId,
      id: "checkpoint_condensed",
      threadId: "thr_condensed",
      createdByRunId: turn.runId,
      expectedPreviousCheckpointId: null,
      expectedHeadSeq: 3,
      executionToken: turn.token,
      reason: "overflow",
      summary: "The user asked to read the repository.",
      summaryFormatVersion: 1,
      summarizedThroughSeq: 2,
      observedHeadSeq: 3,
      estimatedInputTokensBefore: 131_000,
      estimatedInputTokensAfter: 41_000,
      summaryModelId: "tiered",
      createdAt: at(3),
    })

    // Removal proof: drop the checkpoint fallback from `usedTokens`; the meter reads empty.
    const { status, body } = await read("thr_condensed")
    expect(status).toBe(200)
    expect(body).toMatchObject({
      usedTokens: 41_000,
      lastCompaction: {
        reason: "overflow",
        createdAt: at(3).toISOString(),
        estimatedInputTokensBefore: 131_000,
        estimatedInputTokensAfter: 41_000,
      },
    })
    expect(body).not.toHaveProperty("lastCall")
  })

  test("a fresh thread has limits and nothing used; an unknown thread or model is refused", async () => {
    const { storage, read } = createFixture()
    await storage.agents.threads.create({
      projectId,
      id: "thr_fresh",
      ownerPrincipal: { type: "system", id: "system" },
    })

    const fresh = await read("thr_fresh")
    expect(fresh.status).toBe(200)
    expect(fresh.body).toMatchObject({ model: { provider: "test", modelId: "flat" } })
    expect(fresh.body).not.toHaveProperty("usedTokens")

    expect((await read("thr_missing")).status).toBe(404)
    expect((await read("thr_fresh", "?provider=test&modelId=unknown")).status).toBe(404)
    expect((await read("thr_fresh", "?provider=test")).status).toBe(400)
  })
})
