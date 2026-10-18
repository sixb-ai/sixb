import { describe, expect, test } from "bun:test"
import { InMemoryStorage, type Storage } from "../src"
import {
  type AiUsageStorage,
  InMemoryAiUsageStorage,
  type RecordAiModelCallInput,
} from "../src/storage"
import {
  runAiUsageStorageContractSuite,
  seedAiUsageStorageContractExecutions,
} from "../src/testing"

const contractBundles = new Map<AiUsageStorage, InMemoryStorage>()
runAiUsageStorageContractSuite("InMemoryAiUsageStorage", {
  createStorage: () => {
    const bundle = new InMemoryStorage()
    const storage = new InMemoryAiUsageStorage(bundle.executions)
    contractBundles.set(storage, bundle)
    return storage
  },
  setup: async (storage) => {
    const bundle = contractBundles.get(storage)
    if (!bundle) throw new Error("Expected in-memory storage bundle")
    await seedAiUsageStorageContractExecutions(bundle.executions)
  },
  cleanup: (storage) => {
    contractBundles.delete(storage)
  },
})

describe("InMemoryStorage AI usage", () => {
  test("rolls back ledger records, idempotency keys, and group rows", async () => {
    const storage = new InMemoryStorage()
    await createExecution(storage, "project_1", "exec_1")

    await expect(
      storage.transaction(async (tx) => {
        await requireAiUsage(tx).recordModelCall(modelCallInput())
        throw new Error("boom")
      })
    ).rejects.toThrow("boom")

    await expect(storage.aiUsage.summarizeExecution(executionSummaryInput())).resolves.toEqual({
      modelCallCount: 0,
      usage: { reportingStatus: "unavailable" },
    })
    await expect(storage.aiUsage.recordModelCall(modelCallInput())).resolves.toMatchObject({
      created: true,
    })
  })

  test("commits ledger records through the transaction facade", async () => {
    const storage = new InMemoryStorage()
    await createExecution(storage, "project_1", "exec_1")

    await storage.transaction(async (tx) => {
      await requireAiUsage(tx).recordModelCall(modelCallInput())
    })

    await expect(
      storage.aiUsage.summarizeExecution(executionSummaryInput())
    ).resolves.toMatchObject({
      modelCallCount: 1,
      usage: {
        inputTokens: 12,
        outputTokens: 8,
        totalTokens: 20,
        reportingStatus: "complete",
      },
    })
  })
})

function modelCallInput(): RecordAiModelCallInput {
  return {
    id: "usage_1",
    projectId: "project_1",
    executionId: "exec_1",
    attempt: 1,
    callId: "call_1",
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
    executionId: "exec_1",
  } as const
}

async function createExecution(
  storage: InMemoryStorage,
  projectId: string,
  executionId: string
): Promise<void> {
  const primitive = { kind: "workflow" as const, id: "ai-usage-test", runId: executionId }
  await storage.executions.create({
    id: executionId,
    projectId,
    executor: { type: "primitive", kind: primitive.kind, runId: primitive.runId },
    source: { type: "event", eventId: `event:${executionId}` },
    correlationId: `correlation:${executionId}`,
    authorizationRef: { type: "trustedPrimitive", primitive },
  })
}

function requireAiUsage(storage: Storage): AiUsageStorage {
  if (!storage.aiUsage) throw new Error("Expected AI usage storage")
  return storage.aiUsage
}
