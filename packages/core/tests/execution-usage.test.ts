import { describe, expect, test } from "bun:test"
import { InMemoryStorage } from "../src"
import { addUsageSummaries, resolveExecutionUsage } from "../src/runtime/ai-usage"
import { createTestAgentExecution } from "../src/testing"

function modelCall(executionId: string, id: string, usage: Record<string, number>) {
  return {
    id,
    projectId: "project_1",
    executionId,
    attempt: 1,
    callId: `call_${id}`,
    requesterGroupIds: [],
    providerId: "gateway",
    requestedModelId: "openai/gpt-5",
    responseId: `response_${id}`,
    usage,
    occurredAt: new Date("2026-07-01T12:00:00.000Z"),
  }
}

describe("resolveExecutionUsage", () => {
  test("returns ledger summaries in input order and distinguishes no calls from unreported usage", async () => {
    const storage = new InMemoryStorage()
    const execution = (runId: string) =>
      createTestAgentExecution(storage, { projectId: "project_1", actorId: "assistant", runId })
    const reported = await execution("run_reported")
    const unreported = await execution("run_unreported")
    const idle = await execution("run_idle")
    await storage.aiUsage.recordModelCall(
      modelCall(reported, "usage_1", {
        inputTokens: 12,
        outputTokens: 8,
        uncachedInputTokens: 9,
        cacheReadInputTokens: 3,
        cacheWriteInputTokens: 1,
        textOutputTokens: 6,
        reasoningOutputTokens: 2,
      })
    )
    await storage.aiUsage.recordModelCall(modelCall(unreported, "usage_2", {}))

    await expect(
      resolveExecutionUsage({
        storage: storage.aiUsage,
        projectId: "project_1",
        executionIds: ["missing_execution", reported, idle, unreported],
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
      undefined,
      { reportingStatus: "unavailable" },
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
})

describe("addUsageSummaries", () => {
  test("adds executions as their calls would add, and keeps what is known of a partial one", () => {
    // Removal proofs: return `aggregateAiModelCallUsage(usages)` alone; the complete execution's
    // output is lost beside a partial one, and two partial executions come out `unavailable`.
    expect(
      addUsageSummaries([
        { inputTokens: 12, outputTokens: 8, totalTokens: 20, reportingStatus: "complete" },
        { inputTokens: 3, outputTokens: 1, totalTokens: 4, reportingStatus: "complete" },
      ])
    ).toEqual({ inputTokens: 15, outputTokens: 9, totalTokens: 24, reportingStatus: "complete" })

    expect(
      addUsageSummaries([
        { inputTokens: 12, outputTokens: 8, totalTokens: 20, reportingStatus: "complete" },
        { inputTokens: 3, reportingStatus: "partial" },
      ])
    ).toEqual({ inputTokens: 15, outputTokens: 8, totalTokens: 23, reportingStatus: "partial" })
    // A child cut short mid-call knows nothing: the turn keeps its own counts, as a floor.
    expect(
      addUsageSummaries([
        { inputTokens: 12, outputTokens: 8, totalTokens: 20, reportingStatus: "complete" },
        { reportingStatus: "unavailable" },
      ])
    ).toEqual({ inputTokens: 12, outputTokens: 8, totalTokens: 20, reportingStatus: "partial" })

    expect(
      addUsageSummaries([{ reportingStatus: "partial" }, { reportingStatus: "partial" }])
    ).toEqual({ reportingStatus: "partial" })
    expect(
      addUsageSummaries([{ reportingStatus: "unavailable" }, { reportingStatus: "unavailable" }])
    ).toEqual({ reportingStatus: "unavailable" })
    expect(addUsageSummaries([])).toBeUndefined()
  })
})
