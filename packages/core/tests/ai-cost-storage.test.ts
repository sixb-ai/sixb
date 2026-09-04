import { describe, expect, test } from "bun:test"
import { InMemoryStorage } from "../src/storage/in-memory"
import {
  runAiCostStorageContractSuite,
  seedAiCostStorageContractUsage,
} from "../src/testing/ai-cost-storage-contract"
import { runAiModelCallGroupsContractSuite } from "../src/testing/ai-model-call-groups-contract"

runAiModelCallGroupsContractSuite("InMemory model-call groups", {
  createStorage: () => new InMemoryStorage(),
})

runAiCostStorageContractSuite("InMemoryAiCostStorage contract", {
  createStorage: async () => {
    const bundle = new InMemoryStorage()
    await seedAiCostStorageContractUsage(bundle.executions, bundle.aiUsage)
    return bundle.aiCosts
  },
})

describe("atomic AI accounting storage", () => {
  test("rolls usage and valuation back together", async () => {
    const storage = new InMemoryStorage()
    const executionId = "execution_atomic"
    const primitive = { kind: "workflow" as const, id: "workflow", runId: "run" }
    await storage.executions.create({
      id: executionId,
      projectId: "project_1",
      executor: { type: "primitive", kind: primitive.kind, runId: primitive.runId },
      source: { type: "event", eventId: "event_1" },
      correlationId: "correlation_1",
      authorizationRef: { type: "trustedPrimitive", primitive },
    })

    await expect(
      storage.transaction(async (tx) => {
        const result = await tx.aiUsage!.recordModelCall({
          id: "usage_atomic",
          projectId: "project_1",
          executionId,
          attempt: 1,
          callId: "call_atomic",
          requesterGroupIds: [],
          providerId: "anthropic.messages",
          requestedModelId: "claude-opus-4-8",
          responseId: "response_atomic",
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            uncachedInputTokens: 1,
            cacheReadInputTokens: 0,
            cacheWriteInputTokens: 0,
          },
          occurredAt: new Date(),
        })
        await tx.aiCosts!.recordModelCallCost({
          projectId: result.record.projectId,
          usageRecordId: result.record.id,
          status: "rated",
          billingIdentity: { providerId: "test-provider", modelId: "test-model" },
          pricingContext: {},
          priceSource: {
            sourceId: "test-catalog",
            sourceEntryId: "test-provider/test-model",
            sourceVersion: "test-catalog-v1",
            sourceUrl: "https://example.test/ai-pricing.json",
            observedAt: new Date("2026-08-01T00:00:00.000Z"),
          },
          money: { currency: "USD", amountNanos: "2" },
          components: [
            {
              meter: "tokens.input.total",
              quantity: "1",
              rateAmountNanosPerMillion: "1000000",
              chargeAmountNanos: "1",
            },
            {
              meter: "tokens.output.total",
              quantity: "1",
              rateAmountNanosPerMillion: "1000000",
              chargeAmountNanos: "1",
            },
          ],
          ratedAt: new Date(),
        })
        throw new Error("rollback")
      })
    ).rejects.toThrow("rollback")

    await expect(
      storage.aiUsage.summarizeExecution({ projectId: "project_1", executionId })
    ).resolves.toMatchObject({ modelCallCount: 0 })
    await expect(
      storage.aiCosts.listModelCalls({
        projectId: "project_1",
        from: new Date(0),
        to: new Date("2100-01-01T00:00:00.000Z"),
      })
    ).resolves.toMatchObject({ total: 0, items: [] })
  })
})
