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
  AGENT_IMAGE_INPUT_TOKENS,
  createAgentRunExecutionToken,
  estimateAgentContextRequestTokens,
} from "@sixb/core/internal/agents"
import type { AgentMessageRecord, ConversationAgentRunSpec } from "@sixb/core/storage"
import { createTestAgentExecution } from "@sixb/core/testing"
import { AGENT_CONTEXT_DEFAULT_BYTES_PER_TOKEN } from "../../core/src/agents/context-token-rate"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

// What a conversation's context meter reads: what its next request starts from, against the
// limits the worker resolves for the model, and its latest compaction.

const projectId = "agent-thread-context"
const at = (minute: number) => new Date(Date.UTC(2026, 10, 1, 9, minute))

function languageModel(modelId: string, contextWindow: number): LanguageModel {
  return {
    providerId: "test",
    modelId,
    definition: {
      kind: "language",
      providerId: "test",
      modelId,
      contextWindow,
      maxOutputTokens: 128_000,
      capabilities: {},
    },
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
    models: {
      language: [languageModel("small", 200_000), languageModel("large", 1_000_000)],
    },
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
      /** Screenshots the user message attaches. */
      readonly screenshots?: number
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
      parts: [
        { type: "text", text: "Read the repository." },
        ...Array.from({ length: options.screenshots ?? 0 }, (_, index) => ({
          type: "file" as const,
          fileRef: {
            blobId: `blob_${String(index).padStart(64, "0")}`,
            digest: `sha256:${String(index).padStart(64, "0")}` as const,
            sizeBytes: 400_000,
            fileName: `screen-${index}.png`,
            mediaType: "image/png",
          },
        })),
      ],
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

  /**
   * What a request of a thread's stored messages weighs at `bytesPerToken`, by default the rate a
   * model no run measured starts from, as the worker's estimate counts it, less the system prompt
   * and tools the API cannot render.
   */
  async function messagesEstimate(
    threadId: string,
    bytesPerToken = AGENT_CONTEXT_DEFAULT_BYTES_PER_TOKEN
  ): Promise<number> {
    const { messages } = await storage.agents.messages.list({ projectId, threadId, order: "asc" })
    const records: readonly AgentMessageRecord[] = messages
    return estimateAgentContextRequestTokens({
      systemPrompt: "",
      tools: [],
      messages: records,
      bytesPerToken,
    }).tokens
  }

  return { storage, read, seedTurn, messagesEstimate }
}

describe("GET /api/agent-threads/:threadId/context", () => {
  test("measures the last call against the limit of the latest turn's model", async () => {
    const { storage, read, seedTurn, messagesEstimate } = createFixture()
    const turn = await seedTurn("thr_large", "large")
    await storage.aiUsage.recordModelCall({
      id: "usage_first",
      projectId,
      executionId: turn.executionId,
      attempt: 1,
      callId: "call_first",
      requesterGroupIds: [],
      providerId: "test",
      requestedModelId: "large",
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
      requestedModelId: "large",
      responseId: "response_last",
      usage: { inputTokens: 38_000, outputTokens: 1_200, cacheReadInputTokens: 35_000 },
      occurredAt: at(2),
    })

    // Removal proof: resolve the default model instead of the latest turn's; the limit becomes the
    // small model's.
    const { status, body } = await read("thr_large")
    expect(status).toBe(200)
    expect(body).toEqual({
      model: { provider: "test", modelId: "large" },
      windowTokens: 1_000_000,
      limitTokens: 1_000_000 - 16_384,
      // The answer the last call wrote joins what the next request reads.
      usedTokens: 39_200,
      lastCall: {
        inputTokens: 38_000,
        outputTokens: 1_200,
        cacheReadInputTokens: 35_000,
        occurredAt: at(2).toISOString(),
      },
    })

    // Measured against another model, the same conversation has that model's limit, and what it
    // uses is estimated: another model's counts say nothing of this one's tokenizer.
    // Removal proof: anchor on the last call whatever its model; the small model reads 39,200.
    const small = await read("thr_large", "?provider=test&modelId=small")
    expect(small.body).toMatchObject({
      model: { provider: "test", modelId: "small" },
      limitTokens: 200_000 - 16_384,
      usedTokens: await messagesEstimate("thr_large"),
    })
  })

  // Removal proof: answer the anchored count alone when the call matches the model, as the meter
  // once did; it then reads 60,500 while the worker weighs fifteen screenshots at 5,400 each and
  // compacts at the next message.
  test("counts what the worker counts: images at the most a provider charges for one", async () => {
    const { storage, read, seedTurn } = createFixture()
    // The call read the screenshots, and its provider counted them for less.
    const turn = await seedTurn("thr_screenshots", "large", { screenshots: 15 })
    await storage.aiUsage.recordModelCall({
      id: "usage_screenshots",
      projectId,
      executionId: turn.executionId,
      attempt: 1,
      callId: "call_screenshots",
      requesterGroupIds: [],
      providerId: "test",
      requestedModelId: "large",
      responseId: "response_screenshots",
      usage: { inputTokens: 60_000, outputTokens: 500 },
      occurredAt: at(1),
    })

    const { body } = await read("thr_screenshots")
    expect(body.usedTokens).toBeGreaterThanOrEqual(15 * AGENT_IMAGE_INPUT_TOKENS)
  })

  // Removal proof: drop the reduced-request check from `matchingAgentUsageAnchor`; the meter
  // reads a call that saw less than the stored steps replay.
  test("a last call whose request the turn reduced is not what the next request weighs", async () => {
    const { storage, read, seedTurn, messagesEstimate } = createFixture()
    const turn = await seedTurn("thr_reduced", "large", { reduced: true })
    await storage.aiUsage.recordModelCall({
      id: "usage_reduced",
      projectId,
      executionId: turn.executionId,
      attempt: 1,
      callId: "call_reduced",
      requesterGroupIds: [],
      providerId: "test",
      requestedModelId: "large",
      responseId: "response_reduced",
      usage: { inputTokens: 60_000, outputTokens: 900, cacheReadInputTokens: 0 },
      occurredAt: at(1),
    })

    const { body } = await read("thr_reduced")
    expect(body.usedTokens).toBe(await messagesEstimate("thr_reduced"))
    // The call is still the one the cache share is read from.
    expect(body).toMatchObject({ lastCall: { inputTokens: 60_000 } })
  })

  // Removal proof: resolve the budget without the token rates readAgentThreadContextUse reads;
  // the meter then counts at the default 2 while the worker's turn starts from the measured 4.
  test("counts at the bytes per token the model's runs measured, as the next turn starts from", async () => {
    const { storage, read, seedTurn, messagesEstimate } = createFixture()
    await seedTurn("thr_measured", "large", { earlier: true })
    for (let index = 0; index < 20; index += 1) {
      await storage.agents.tokenRates.record({
        projectId,
        providerId: "test",
        modelId: "large",
        runId: `earlier_run_${index}`,
        bytes: 40_000,
        tokens: 10_000,
        measuredAt: at(index),
      })
    }

    const { body } = await read("thr_measured")
    expect(body.usedTokens).toBe(await messagesEstimate("thr_measured", 4))
    expect(body.usedTokens).toBeLessThan(await messagesEstimate("thr_measured"))
  })

  // Removal proof: resolve the budget without the turn's reasoning; the limit keeps the 16,384
  // reserve while the worker leaves the reasoning budget.
  test("the limit leaves the reserve the latest turn's reasoning budget needs", async () => {
    const { read, seedTurn } = createFixture()
    await seedTurn("thr_reasoning", "small", { reasoning: { budgetTokens: 20_000 } })

    const { body } = await read("thr_reasoning")
    expect(body).toMatchObject({ limitTokens: 200_000 - 20_001 })
  })

  test("a compaction no call followed yet is measured by its own estimate", async () => {
    const { storage, read, seedTurn } = createFixture()
    const turn = await seedTurn("thr_condensed", "large", { answer: false, earlier: true })
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
      summaryModelId: "large",
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
    expect(fresh.body).toMatchObject({ model: { provider: "test", modelId: "small" } })
    expect(fresh.body).not.toHaveProperty("usedTokens")

    expect((await read("thr_missing")).status).toBe(404)
    expect((await read("thr_fresh", "?provider=test&modelId=unknown")).status).toBe(404)
    expect((await read("thr_fresh", "?provider=test")).status).toBe(400)
  })
})
