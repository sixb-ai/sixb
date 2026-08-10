import { describe, expect, test } from "bun:test"
import type { AiUsageStorage, RecordAiModelCallInput } from "@sixb/core/storage"
import { runAiUsageStorageContractSuite } from "@sixb/core/testing"
import { SqliteStorage } from "../src"
import { SqliteAiUsageStorage } from "../src/ai-usage-storage"

runAiUsageStorageContractSuite("SqliteAiUsageStorage", {
  createStorage: () => new SqliteAiUsageStorage(),
  cleanup: (storage) => {
    storage.close()
  },
})

describe("SqliteStorage AI usage", () => {
  test("is bundled and rolls ledger writes back with the outer transaction", async () => {
    const storage = new SqliteStorage()

    try {
      expect(storage.aiUsage).toBeDefined()
      await expect(
        storage.transaction(async (tx) => {
          await requireAiUsage(tx.aiUsage).recordModelCall(modelCallInput())
          throw new Error("boom")
        })
      ).rejects.toThrow("boom")

      await expect(storage.aiUsage.summarizeExecution(summaryInput())).resolves.toEqual({
        modelCallCount: 0,
        usage: { reportingStatus: "unavailable" },
      })
      await expect(storage.aiUsage.recordModelCall(modelCallInput())).resolves.toMatchObject({
        created: true,
      })
    } finally {
      storage.close()
    }
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
    requesterGroupIds: ["engineering", "support"],
    providerId: "gateway",
    requestedModelId: "openai/gpt-5",
    responseId: "response_1",
    usage: { inputTokens: 12, outputTokens: 8 },
    occurredAt: new Date("2026-06-23T10:00:00.000Z"),
    recordedAt: new Date("2026-06-23T10:00:01.000Z"),
  }
}

function summaryInput() {
  return {
    projectId: "project_1",
    execution: { kind: "agentRun", runId: "run_1" },
  } as const
}

function requireAiUsage(storage: AiUsageStorage | undefined): AiUsageStorage {
  if (!storage) throw new Error("Expected AI usage storage")
  return storage
}
