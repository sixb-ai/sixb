import { describe, expect, test } from "bun:test"
import type { AiCostStorage, AiModelCallCostRecord } from "../storage/ai-cost"
import { AiCostStorageError } from "../storage/ai-cost"
import type { AiUsageStorage } from "../storage/ai-usage"
import type { ExecutionStorage } from "../storage/executions"

export interface AiStorageContractSuiteOptions<TStorage> {
  readonly createStorage: () => TStorage | Promise<TStorage>
  readonly setup?: (storage: TStorage) => void | Promise<void>
  readonly cleanup?: (storage: TStorage) => void | Promise<void>
}

const projectId = "cost-contract-project"
const executionId = "exec_cost_1"
const otherExecutionId = "exec_cost_2"

function priceSource(entry: string) {
  return {
    sourceId: "test-catalog",
    sourceEntryId: entry,
    sourceVersion: "test-catalog-v1",
    sourceUrl: "https://example.test/ai-pricing.json",
    observedAt: new Date("2026-08-01T00:00:00.000Z"),
  }
}

function ratedCost(
  usageRecordId = "usage_1",
  overrides: Partial<Extract<AiModelCallCostRecord, { status: "rated" }>> = {}
): Extract<AiModelCallCostRecord, { status: "rated" }> {
  return {
    projectId,
    usageRecordId,
    status: "rated",
    billingIdentity: { providerId: "vercel", modelId: "openai/gpt-5" },
    pricingContext: {},
    priceSource: priceSource("vercel/openai/gpt-5"),
    money: { currency: "USD", amountNanos: "95000" },
    components: [
      {
        meter: "tokens.input.uncached",
        quantity: "12",
        rateAmountNanosPerMillion: "1250000000",
        chargeAmountNanos: "15000",
      },
      {
        meter: "tokens.input.cacheRead",
        quantity: "0",
        rateAmountNanosPerMillion: "125000000",
        chargeAmountNanos: "0",
      },
      {
        meter: "tokens.output.total",
        quantity: "8",
        rateAmountNanosPerMillion: "10000000000",
        chargeAmountNanos: "80000",
      },
    ],
    ratedAt: new Date("2026-08-01T12:00:00.200Z"),
    ...overrides,
  }
}

function unpriceableCost(): Extract<AiModelCallCostRecord, { status: "unpriceable" }> {
  return {
    projectId,
    usageRecordId: "usage_2",
    status: "unpriceable",
    billingIdentity: { providerId: "vercel", modelId: "unpriced/model" },
    pricingContext: {},
    priceSource: priceSource("vercel/unpriced/model"),
    reason: "missingCatalogEntry",
    ratedAt: new Date("2026-08-01T12:00:00.200Z"),
  }
}

export function runAiCostStorageContractSuite<TStorage extends AiCostStorage>(
  name: string,
  options: AiStorageContractSuiteOptions<TStorage>
): void {
  describe(name, () => {
    async function fixture(): Promise<TStorage> {
      const storage = await options.createStorage()
      await options.setup?.(storage)
      return storage
    }

    test("records model-call costs idempotently", async () => {
      const storage = await fixture()
      try {
        await expect(storage.recordModelCallCost(ratedCost())).resolves.toBeUndefined()
        await expect(storage.recordModelCallCost(ratedCost())).resolves.toBeUndefined()
        await expect(
          storage.listModelCalls({
            projectId,
            from: new Date("2026-08-01T00:00:00.000Z"),
            to: new Date("2026-08-02T00:00:00.000Z"),
            valuationStatus: "rated",
          })
        ).resolves.toMatchObject({
          total: 1,
          items: [{ usage: { id: "usage_1" }, cost: ratedCost(), valuationStatus: "rated" }],
        })
      } finally {
        await options.cleanup?.(storage)
      }
    })

    test("stores explicit unpriceable results and pricing context", async () => {
      const storage = await fixture()
      try {
        const deploymentCost: AiModelCallCostRecord = {
          projectId,
          usageRecordId: "usage_deployment",
          status: "unpriceable",
          billingIdentity: { providerId: "openai", modelId: "gpt-5" },
          pricingContext: { deploymentId: "production" },
          priceSource: priceSource("openai/gpt-5"),
          reason: "unsupportedPricingDimension",
          ratedAt: new Date("2026-08-03T12:00:00.200Z"),
        }
        await storage.recordModelCallCost(unpriceableCost())
        await storage.recordModelCallCost(deploymentCost)
        await expect(
          storage.listModelCalls({
            projectId,
            from: new Date("2026-08-03T00:00:00.000Z"),
            to: new Date("2026-08-04T00:00:00.000Z"),
            valuationStatus: "unpriceable",
          })
        ).resolves.toMatchObject({
          total: 1,
          items: [{ cost: deploymentCost, valuationStatus: "unpriceable" }],
        })
      } finally {
        await options.cleanup?.(storage)
      }
    })

    test("summarizes and queries accounting without inventing missing costs", async () => {
      const storage = await fixture()
      try {
        await storage.recordModelCallCost(ratedCost())
        await storage.recordModelCallCost(unpriceableCost())
        await expect(
          storage.summarizeExecutions({ projectId, executionIds: [executionId] })
        ).resolves.toEqual([
          {
            amounts: [{ currency: "USD", amountNanos: "95000" }],
            ratedCallCount: 1,
            unpriceableCallCount: 1,
            unvaluedCallCount: 1,
          },
        ])

        const overview = await storage.queryProjectOverview({
          projectId,
          from: new Date("2026-08-01T00:00:00.000Z"),
          to: new Date("2026-08-02T00:00:00.000Z"),
          bucket: "day",
        })
        expect(overview.totals).toEqual({
          modelCallCount: 3,
          usage: {
            inputTokens: 15,
            outputTokens: 12,
            totalTokens: 27,
            reportingStatus: "complete",
          },
          costs: {
            amounts: [{ currency: "USD", amountNanos: "95000" }],
            ratedCallCount: 1,
            unpriceableCallCount: 1,
            unvaluedCallCount: 1,
          },
        })
        expect(overview.series).toMatchObject([{ modelCallCount: 3 }])
        expect(overview.models).toMatchObject([
          { providerId: "gateway", modelId: "openai/gpt-5", modelCallCount: 2 },
          { providerId: "gateway", modelId: "unpriced/model", modelCallCount: 1 },
        ])
        await expect(
          storage.queryProjectOverview({
            projectId,
            from: new Date("2026-08-01T00:00:00.000Z"),
            to: new Date("2026-08-02T00:00:00.000Z"),
            bucket: "day",
            providerId: "gateway",
            modelId: "unpriced/model",
          })
        ).resolves.toMatchObject({ totals: { modelCallCount: 1 } })
        await expect(
          storage.listModelCalls({
            projectId,
            from: new Date("2026-08-01T00:00:00.000Z"),
            to: new Date("2026-08-02T00:00:00.000Z"),
            limit: 1,
            offset: 1,
          })
        ).resolves.toMatchObject({
          total: 3,
          hasMore: true,
          items: [{ usage: { id: "usage_2" } }],
        })
        await expect(
          storage.listModelCalls({
            projectId,
            from: new Date("2026-08-01T00:00:00.000Z"),
            to: new Date("2026-08-02T00:00:00.000Z"),
            valuationStatus: "unpriceable",
          })
        ).resolves.toMatchObject({
          total: 1,
          hasMore: false,
          items: [{ usage: { id: "usage_2" }, valuationStatus: "unpriceable" }],
        })
      } finally {
        await options.cleanup?.(storage)
      }
    })

    test("rejects missing usage and mismatched billed quantities", async () => {
      const storage = await fixture()
      try {
        const missing = ratedCost("missing")
        const missingError = await storage.recordModelCallCost(missing).catch((value) => value)
        expect(missingError).toBeInstanceOf(AiCostStorageError)
        expect((missingError as AiCostStorageError).code).toBe("missing_usage")

        const base = ratedCost()
        const mismatch = ratedCost("usage_1", {
          money: { currency: "USD", amountNanos: "96250" },
          components: [
            { ...base.components[0]!, quantity: "13", chargeAmountNanos: "16250" },
            ...base.components.slice(1),
          ],
        })
        const mismatchError = await storage.recordModelCallCost(mismatch).catch((value) => value)
        expect(mismatchError).toBeInstanceOf(AiCostStorageError)
        expect((mismatchError as AiCostStorageError).code).toBe("cost_mismatch")
      } finally {
        await options.cleanup?.(storage)
      }
    })
  })
}

/** Seed immutable usage used by every cost-storage provider contract. */
export async function seedAiCostStorageContractUsage(
  executions: ExecutionStorage,
  usage: AiUsageStorage
): Promise<void> {
  for (const fixture of [
    { projectId, executionId },
    { projectId, executionId: otherExecutionId },
  ]) {
    if (await executions.getById({ projectId: fixture.projectId, id: fixture.executionId }))
      continue
    const primitive = {
      kind: "workflow" as const,
      id: "ai-cost-contract",
      runId: fixture.executionId,
    }
    await executions.create({
      id: fixture.executionId,
      projectId: fixture.projectId,
      executor: { type: "primitive", kind: primitive.kind, runId: primitive.runId },
      source: { type: "event", eventId: `test_event:${fixture.executionId}` },
      correlationId: `test_correlation:${fixture.executionId}`,
      authorizationRef: { type: "trustedPrimitive", primitive },
    })
  }

  for (const fixture of [
    { id: "usage_1", model: "openai/gpt-5", input: 12, output: 8 },
    { id: "usage_2", model: "unpriced/model", input: 1, output: 1 },
    { id: "usage_3", model: "openai/gpt-5", input: 2, output: 3 },
  ]) {
    await usage.recordModelCall({
      id: fixture.id,
      projectId,
      executionId,
      attempt: 1,
      callId: `call_${fixture.id}`,
      requesterGroupIds: [],
      providerId: "gateway",
      requestedModelId: fixture.model,
      responseId: `response_${projectId}_${fixture.id}`,
      usage: {
        inputTokens: fixture.input,
        outputTokens: fixture.output,
        ...(fixture.id === "usage_1"
          ? { uncachedInputTokens: fixture.input, cacheReadInputTokens: 0 }
          : {}),
      },
      occurredAt: new Date("2026-08-01T12:00:00.000Z"),
      recordedAt: new Date("2026-08-01T12:00:00.100Z"),
    })
  }

  await usage.recordModelCall({
    id: "usage_deployment",
    projectId,
    executionId: otherExecutionId,
    attempt: 1,
    callId: "call_usage_deployment",
    requesterGroupIds: [],
    providerId: "openai.responses",
    requestedModelId: "gpt-5",
    responseId: "response_usage_deployment",
    usage: {
      inputTokens: 2,
      outputTokens: 3,
      uncachedInputTokens: 2,
      cacheReadInputTokens: 0,
    },
    occurredAt: new Date("2026-08-03T12:00:00.000Z"),
    recordedAt: new Date("2026-08-03T12:00:00.100Z"),
  })
}
