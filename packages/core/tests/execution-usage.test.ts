import { describe, expect, test } from "bun:test"
import { InMemoryStorage } from "../src"
import { resolveExecutionUsage } from "../src/runtime/ai-usage"
import { createTestAgentExecution } from "../src/testing"

async function createUsageStorage(runId = "run_1") {
  const storage = new InMemoryStorage()
  const executionId = await createTestAgentExecution(storage, {
    projectId: "project_1",
    agentId: "assistant",
    runId,
  })
  return { storage: storage.aiUsage, executionId }
}

describe("resolveExecutionUsage", () => {
  test("returns provider-neutral ledger summaries in input order", async () => {
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
      resolveExecutionUsage({
        storage,
        projectId: "project_1",
        executionIds: ["missing_execution", executionId],
      })
    ).resolves.toEqual([
      undefined,
      {
        inputTokens: 12,
        outputTokens: 8,
        totalTokens: 20,
        uncachedInputTokens: 9,
        cacheReadInputTokens: 3,
        cacheWriteInputTokens: 1,
        textOutputTokens: 6,
        reasoningOutputTokens: 2,
        reportingStatus: "complete",
      },
    ])
  })

  test("preserves batch shape when AI usage storage is unavailable", async () => {
    await expect(
      resolveExecutionUsage({
        storage: undefined,
        projectId: "project_1",
        executionIds: ["execution_1", "execution_2"],
      })
    ).resolves.toEqual([undefined, undefined])
  })

  test("distinguishes no calls from a call whose usage is unavailable", async () => {
    const { storage, executionId } = await createUsageStorage()
    await expect(
      resolveExecutionUsage({ storage, projectId: "project_1", executionIds: [executionId] })
    ).resolves.toEqual([undefined])

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
      resolveExecutionUsage({ storage, projectId: "project_1", executionIds: [executionId] })
    ).resolves.toEqual([{ reportingStatus: "unavailable" }])
  })
})
