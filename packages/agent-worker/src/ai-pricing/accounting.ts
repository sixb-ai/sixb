import { createHash } from "node:crypto"
import type {
  AiBillableMeter,
  AiCostStorage,
  AiModelCallCostRecord,
  AiPricingContext,
  AiUsageStorage,
  RecordAiModelCallResult,
  Storage,
} from "@sixb/core/storage"
import type { AgentWorkerStorage, RecoverAiModelCallInput } from "../types"

interface RecordAiModelCallAccountingInput extends RecoverAiModelCallInput {
  readonly storage: AgentWorkerStorage
}

interface AiAccountingCapabilities {
  readonly aiUsage: AiUsageStorage
  readonly aiCosts: AiCostStorage
}

/** Atomically append one provider call's usage and the valuation captured by the model runtime. */
export async function recordAiModelCallAccounting(
  input: RecordAiModelCallAccountingInput
): Promise<RecordAiModelCallResult> {
  return input.storage.transaction(async (tx) => {
    const { aiUsage, aiCosts } = requireAccountingCapabilities(tx)
    const usage = await aiUsage.recordModelCall(input.usage)
    // Usage deduplicates provider lifecycle replays by execution/call identity. Always attach the
    // valuation to the canonical row it returns, not the fresh candidate ID from a replay.
    await aiCosts.recordModelCallCost(modelCostRecord(input, usage.record.id))
    return usage
  })
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
  if (!storage.aiUsage || !storage.aiCosts) {
    throw new Error(
      "[SixbAgentWorker] AI model-call accounting requires storage.aiUsage and storage.aiCosts."
    )
  }
  return { aiUsage: storage.aiUsage, aiCosts: storage.aiCosts }
}
