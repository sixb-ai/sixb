import { describe, expect, test } from "bun:test"
import { InMemoryStorage } from "@sixb/core"
import { createTestAgentExecution } from "@sixb/core/testing"
import { resolveAiUsageSummaries, resolveAiUsageSummary } from "../src/ai-usage"

async function createUsageStorage(runId = "run_1") {
  const storage = new InMemoryStorage()
  const executionId = await createTestAgentExecution(storage, {
    projectId: "project_1",
    agentId: "assistant",
    runId,
  })
  return { storage: storage.aiUsage, executionId }
}

describe("resolveAiUsageSummary", () => {
  test("returns the complete provider-neutral ledger summary", async () => {
    const { storage, executionId } = await createUsageStorage()
    await storage.recordModelCall({
      id: "usage_1",
      projectId: "project_1",
      executionId,
      attempt: 1,
      callId: "call_1",
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
      resolveAiUsageSummary({ storage, projectId: "project_1", executionId })
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
    const { storage, executionId } = await createUsageStorage()
    await storage.recordModelCall({
      id: "usage_batch",
      projectId: "project_1",
      executionId,
      attempt: 1,
      callId: "call_batch",
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
        executionIds: ["missing_execution", executionId],
      })
    ).resolves.toEqual([
      undefined,
      { inputTokens: 3, outputTokens: 2, totalTokens: 5, reportingStatus: "complete" },
    ])
  })

  test("preserves batch shape when AI usage storage is unavailable", async () => {
    await expect(
      resolveAiUsageSummaries({
        storage: undefined,
        projectId: "project_1",
        executionIds: ["execution_1", "execution_2"],
      })
    ).resolves.toEqual([undefined, undefined])
  })

  test("omits usage when the ledger has no model calls", async () => {
    const { storage, executionId } = await createUsageStorage()
    await expect(
      resolveAiUsageSummary({
        storage,
        projectId: "project_1",
        executionId,
      })
    ).resolves.toBeUndefined()
  })

  test("preserves unavailable usage when a model call was recorded", async () => {
    const { storage, executionId } = await createUsageStorage()
    await storage.recordModelCall({
      id: "usage_unavailable",
      projectId: "project_1",
      executionId,
      attempt: 1,
      callId: "call_unavailable",
      requesterGroupIds: [],
      providerId: "gateway",
      requestedModelId: "openai/gpt-5",
      responseId: "response_unavailable",
      usage: {},
      occurredAt: new Date("2026-07-01T12:00:00.000Z"),
    })

    await expect(
      resolveAiUsageSummary({ storage, projectId: "project_1", executionId })
    ).resolves.toEqual({ reportingStatus: "unavailable" })
  })
})
