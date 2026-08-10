import { describe, expect, test } from "bun:test"
import { InMemoryAiUsageStorage } from "@sixb/core/storage"
import { resolveAiUsageSummaries, resolveAiUsageSummary } from "../src/ai-usage"

const execution = { kind: "agentRun", runId: "run_1" } as const

describe("resolveAiUsageSummary", () => {
  test("returns the complete provider-neutral ledger summary", async () => {
    const storage = new InMemoryAiUsageStorage()
    await storage.recordModelCall({
      id: "usage_1",
      projectId: "project_1",
      execution,
      attempt: 1,
      callId: "call_1",
      requesterPrincipal: { type: "user", id: "usr_1" },
      requesterGroupIds: [],
      providerId: "gateway",
      requestedModelId: "openai/gpt-5",
      responseId: "response_1",
      usage: {
        inputTokens: 12,
        outputTokens: 8,
        uncachedInputTokens: 9,
        cacheReadInputTokens: 3,
        cacheWriteInputTokens: 1,
        textOutputTokens: 6,
        reasoningOutputTokens: 2,
      },
      occurredAt: new Date("2026-07-01T12:00:00.000Z"),
    })

    await expect(
      resolveAiUsageSummary({ storage, projectId: "project_1", execution })
    ).resolves.toEqual({
      inputTokens: 12,
      outputTokens: 8,
      totalTokens: 20,
      uncachedInputTokens: 9,
      cacheReadInputTokens: 3,
      cacheWriteInputTokens: 1,
      textOutputTokens: 6,
      reasoningOutputTokens: 2,
      reportingStatus: "complete",
    })
  })

  test("resolves a batch in input order and omits unavailable summaries", async () => {
    const storage = new InMemoryAiUsageStorage()
    await storage.recordModelCall({
      id: "usage_batch",
      projectId: "project_1",
      execution,
      attempt: 1,
      callId: "call_batch",
      requesterPrincipal: { type: "user", id: "usr_1" },
      requesterGroupIds: [],
      providerId: "gateway",
      requestedModelId: "openai/gpt-5",
      responseId: "response_batch",
      usage: { inputTokens: 3, outputTokens: 2 },
      occurredAt: new Date("2026-07-01T12:00:00.000Z"),
    })

    await expect(
      resolveAiUsageSummaries({
        storage,
        projectId: "project_1",
        executions: [{ kind: "agentRun", runId: "missing" }, execution],
      })
    ).resolves.toEqual([
      undefined,
      { inputTokens: 3, outputTokens: 2, totalTokens: 5, reportingStatus: "complete" },
    ])
  })

  test("omits usage when the ledger has no model calls", async () => {
    await expect(
      resolveAiUsageSummary({
        storage: new InMemoryAiUsageStorage(),
        projectId: "project_1",
        execution,
      })
    ).resolves.toBeUndefined()
  })

  test("preserves unavailable usage when a model call was recorded", async () => {
    const storage = new InMemoryAiUsageStorage()
    await storage.recordModelCall({
      id: "usage_unavailable",
      projectId: "project_1",
      execution,
      attempt: 1,
      callId: "call_unavailable",
      requesterPrincipal: { type: "user", id: "usr_1" },
      requesterGroupIds: [],
      providerId: "gateway",
      requestedModelId: "openai/gpt-5",
      responseId: "response_unavailable",
      usage: {},
      occurredAt: new Date("2026-07-01T12:00:00.000Z"),
    })

    await expect(
      resolveAiUsageSummary({ storage, projectId: "project_1", execution })
    ).resolves.toEqual({ reportingStatus: "unavailable" })
  })
})
