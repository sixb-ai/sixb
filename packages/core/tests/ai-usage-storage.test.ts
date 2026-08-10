import { describe, expect, test } from "bun:test"
import { InMemoryAiUsageStorage, type RecordAiModelCallInput } from "../src/storage"
import { runAiUsageStorageContractSuite } from "../src/testing"

runAiUsageStorageContractSuite("InMemoryAiUsageStorage", {
  createStorage: () => new InMemoryAiUsageStorage(),
})

describe("InMemoryAiUsageStorage", () => {
  test("snapshots model-call records, idempotency keys, and group rows", async () => {
    const storage = new InMemoryAiUsageStorage()
    const empty = storage.snapshot()

    await storage.recordModelCall(modelCallInput())
    const populated = storage.snapshot()
    expect(populated.records.size).toBe(1)
    expect(populated.recordKeysByIdempotencyKey.size).toBe(1)
    expect([...populated.groupRows.values()]).toEqual([
      {
        projectId: "project_1",
        usageRecordId: "usage_1",
        groupId: "engineering",
        occurredAt: new Date("2026-06-23T10:00:00.000Z"),
      },
      {
        projectId: "project_1",
        usageRecordId: "usage_1",
        groupId: "support",
        occurredAt: new Date("2026-06-23T10:00:00.000Z"),
      },
    ])

    storage.restore(empty)
    await expect(storage.summarizeExecution(executionSummaryInput())).resolves.toEqual({
      reportingStatus: "unavailable",
    })
    await expect(storage.recordModelCall(modelCallInput())).resolves.toMatchObject({
      created: true,
    })
  })
})

function modelCallInput(): RecordAiModelCallInput {
  return {
    id: "usage_1",
    projectId: "project_1",
    execution: { kind: "agentRun", runId: "run_1" },
    attempt: 1,
    callId: "call_1",
    requesterPrincipal: { type: "user", id: "usr_1" },
    requesterGroupIds: ["support", "engineering", "support"],
    providerId: "gateway",
    requestedModelId: "openai/gpt-5",
    responseId: "response_1",
    usage: { inputTokens: 12, outputTokens: 8 },
    rawUsage: { input_tokens: 12, output_tokens: 8 },
    occurredAt: new Date("2026-06-23T10:00:00.000Z"),
    recordedAt: new Date("2026-06-23T10:00:01.000Z"),
  }
}

function executionSummaryInput() {
  return {
    projectId: "project_1",
    execution: { kind: "agentRun", runId: "run_1" },
  } as const
}
