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

describe("InMemoryAiUsageStorage", () => {
  test("snapshots model-call records, idempotency keys, and group rows", async () => {
    const bundle = new InMemoryStorage()
    const storage = new InMemoryAiUsageStorage(bundle.executions)
    await createExecution(bundle, "project_1", "exec_1")
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
      modelCallCount: 0,
      usage: { reportingStatus: "unavailable" },
    })
    await expect(storage.recordModelCall(modelCallInput())).resolves.toMatchObject({
      created: true,
    })
  })
})

describe("InMemoryStorage AI usage", () => {
  test("is wired into the composite storage", () => {
    const storage = new InMemoryStorage()
    expect(storage.aiUsage).toBeDefined()
  })

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
