import { describe, expect, test } from "bun:test"
import type { AiUsageStorage, RecordAiModelCallInput } from "@sixb/core/storage"
import {
  runAiUsageStorageContractSuite,
  seedAiUsageStorageContractExecutions,
} from "@sixb/core/testing"
import type { PostgresStorage } from "../src"
import { createTestStorage } from "./helpers"

const bundles = new Map<AiUsageStorage, PostgresStorage>()

runAiUsageStorageContractSuite("PgAiUsageStorage", {
  createStorage: async () => {
    const { storage } = await createTestStorage()
    bundles.set(storage.aiUsage, storage)
    return storage.aiUsage
  },
  setup: async (aiUsage) => {
    const storage = bundles.get(aiUsage)
    if (!storage) throw new Error("Expected PostgreSQL storage bundle")
    await seedAiUsageStorageContractExecutions(storage.executions)
  },
  cleanup: async (aiUsage) => {
    const storage = bundles.get(aiUsage)
    if (storage) {
      bundles.delete(aiUsage)
      await storage.dropSchema()
      await storage.close()
    }
  },
})

describe("PostgresStorage AI usage", () => {
  test("is bundled and rolls ledger writes back with the outer transaction", async () => {
    const { storage } = await createTestStorage()

    try {
      expect(storage.aiUsage).toBeDefined()
      await seedAiUsageStorageContractExecutions(storage.executions)
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
      await storage.dropSchema()
      await storage.close()
    }
  })
})

function modelCallInput(): RecordAiModelCallInput {
  return {
    id: "usage_1",
    projectId: "contract-project",
    executionId: "exec_agent_1",
    attempt: 1,
    callId: "call_1",
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
    projectId: "contract-project",
    executionId: "exec_agent_1",
  } as const
}

function requireAiUsage(storage: AiUsageStorage | undefined): AiUsageStorage {
  if (!storage) throw new Error("Expected AI usage storage")
  return storage
}
