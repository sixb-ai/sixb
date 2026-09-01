import { createHash } from "node:crypto"
import {
  aiModelCallCostMatchesUsage,
  normalizeAiModelCallCostRecord,
} from "@sixb/core/internal/ai-cost-storage-provider"
import { assertJsonObject, type ModelCostEstimate } from "@sixb/core/models"
import type {
  AiBillableMeter,
  AiCostStorage,
  AiLimitStorage,
  AiModelCallCostRecord,
  AiModelCallUsageRecord,
  AiPricingContext,
  AiUsageStorage,
  RecordAiModelCallResult,
  Storage,
} from "@sixb/core/storage"
import { normalizeAiModelCallRecord } from "@sixb/core/storage"
import type { AgentWorkerStorage, RecoverAiModelCallInput } from "./types"

interface RecordAiModelCallAccountingInput extends RecoverAiModelCallInput {
  readonly storage: AgentWorkerStorage
}

interface AiAccountingCapabilities {
  readonly aiUsage: AiUsageStorage
  readonly aiCosts: AiCostStorage
  readonly aiLimits: AiLimitStorage
}

/** Atomically append one provider call's usage and the valuation captured by the model runtime. */
export async function recordAiModelCallAccounting(
  input: RecordAiModelCallAccountingInput
): Promise<RecordAiModelCallResult> {
  return input.storage.transaction(async (tx) => {
    const { aiUsage, aiCosts, aiLimits } = requireAccountingCapabilities(tx)
    const usage = await aiUsage.recordModelCall(input.usage)
    // Usage deduplicates provider lifecycle replays by execution/call identity. Always attach the
    // valuation to the canonical row it returns, not the fresh candidate ID from a replay.
    const canonical = normalizeModelCallAccounting({
      ...input,
      usage: usage.record,
      ratedAt: usage.record.recordedAt,
    })
    const record = modelCostRecord(canonical, usage.record.id)
    const estimate =
      canonical.cost.status !== "reported" || canonical.estimate === undefined
        ? undefined
        : modelCostRecord({ ...canonical, cost: canonical.estimate }, usage.record.id)
    await aiCosts.recordModelCallCost({
      ...record,
      ...(estimate === undefined
        ? {}
        : {
            estimate:
              estimate.status === "rated"
                ? { status: "rated", money: estimate.money, components: estimate.components }
                : {
                    status: "unpriceable",
                    reason: estimate.reason,
                    ...(estimate.missingMeters === undefined
                      ? {}
                      : { missingMeters: estimate.missingMeters }),
                  },
          }),
    })
    if (usage.created) {
      await aiLimits.recordModelCallActuals({
        projectId: usage.record.projectId,
        usageRecordId: usage.record.id,
        recordedAt: input.ratedAt,
      })
    }
    if (input.reconcileLimitReservation) {
      await aiLimits.reconcileModelCall({
        projectId: usage.record.projectId,
        executionId: usage.record.executionId,
        attempt: usage.record.attempt,
        callId: usage.record.callId,
        usageRecordId: usage.record.id,
        reconciledAt: input.ratedAt,
      })
    }
    return usage
  })
}

/** Sanitize optional enrichment before either persistence or a JSON-safe recovery handoff. */
export function normalizeModelCallAccounting(
  input: RecoverAiModelCallInput
): RecoverAiModelCallInput {
  const usage = normalizeAiModelCallRecord(input.usage)
  return {
    ...input,
    cost:
      input.cost.status === "reported" ? input.cost : validatedEstimate(input.cost, input, usage),
    ...(input.estimate === undefined
      ? {}
      : { estimate: validatedEstimate(input.estimate, input, usage) }),
  }
}

function validatedEstimate(
  cost: ModelCostEstimate,
  input: RecoverAiModelCallInput,
  usage: AiModelCallUsageRecord
): ModelCostEstimate {
  try {
    assertJsonObject(cost, "model cost estimate")
    const record = normalizeAiModelCallCostRecord(modelCostRecord({ ...input, cost }, usage.id))
    if (!aiModelCallCostMatchesUsage(record, usage)) {
      throw new TypeError("Estimate quantities do not match recorded usage.")
    }
    return structuredClone(cost)
  } catch {
    console.warn(
      "[SixbAgentWorker] Invalid model cost estimate; preserving call usage and provider cost."
    )
    return { status: "unpriceable", reason: "inconsistent-usage" }
  }
}

function modelCostRecord(
  input: RecoverAiModelCallInput,
  usageRecordId: string
): AiModelCallCostRecord {
  const billingIdentity = {
    providerId: input.usage.providerId,
    modelId: input.usage.requestedModelId,
  }
  const pricingContext: AiPricingContext = {
    ...(input.route?.providerId === undefined ? {} : { routedProviderId: input.route.providerId }),
    ...(input.route?.modelId === undefined ? {} : { routedModelId: input.route.modelId }),
  }
  if (input.cost.status === "reported" || input.cost.status === "rated") {
    return {
      projectId: input.usage.projectId,
      usageRecordId,
      status: "rated",
      billingIdentity,
      pricingContext,
      priceSource: costPriceSource(input.usage, input.cost),
      money: input.cost.money,
      components: input.cost.status === "rated" ? input.cost.components : [],
      ratedAt: new Date(input.ratedAt),
    }
  }

  const reason =
    input.cost.reason === "missing-rate-card"
      ? "missingRateCard"
      : input.cost.reason === "missing-usage"
        ? "missingUsageMeter"
        : "invalidUsageForFormula"
  const missingMeters =
    reason === "missingUsageMeter" ? normalizeMissingMeters(input.cost.missingMeters) : undefined
  return {
    projectId: input.usage.projectId,
    usageRecordId,
    status: "unpriceable",
    billingIdentity,
    pricingContext,
    reason,
    ...(missingMeters === undefined ? {} : { missingMeters }),
    ratedAt: new Date(input.ratedAt),
  }
}

function costPriceSource(
  usage: RecoverAiModelCallInput["usage"],
  cost: Extract<RecoverAiModelCallInput["cost"], { status: "reported" | "rated" }>
) {
  if (cost.status === "reported") {
    return {
      sourceId: "provider-reported",
      sourceEntryId: `${usage.providerId}/${usage.responseId}`,
      sourceVersion: "response-v1",
      observedAt: new Date(usage.occurredAt),
    }
  }
  const rates = cost.components.map(({ meter, rateAmountNanosPerMillion }) => ({
    meter,
    rateAmountNanosPerMillion,
  }))
  const version = createHash("sha256").update(JSON.stringify(rates)).digest("hex")
  return {
    sourceId: "model-rate-card",
    sourceEntryId: `${usage.providerId}/${usage.requestedModelId}`,
    sourceVersion: `sha256:${version}`,
    observedAt: new Date(usage.occurredAt),
  }
}

function normalizeMissingMeters(
  meters: Extract<RecoverAiModelCallInput["cost"], { status: "unpriceable" }>["missingMeters"]
): readonly AiBillableMeter[] {
  const fallback: readonly AiBillableMeter[] = ["tokens.input.total", "tokens.output.total"]
  return [...new Set<AiBillableMeter>(meters ?? fallback)]
}

function requireAccountingCapabilities(storage: Storage): AiAccountingCapabilities {
  if (!storage.aiUsage || !storage.aiCosts || !storage.aiLimits) {
    throw new Error(
      "[SixbAgentWorker] AI model-call accounting requires storage.aiUsage, storage.aiCosts, and storage.aiLimits."
    )
  }
  return { aiUsage: storage.aiUsage, aiCosts: storage.aiCosts, aiLimits: storage.aiLimits }
}
