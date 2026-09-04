import type {
  AiCostStorage,
  AiLimitStorage,
  AiPricingContext,
  AiUsageStorage,
  RecordAiModelCallInput,
  RecordAiModelCallResult,
  Storage,
} from "@sixb/core/storage"
import type { AgentWorkerStorage } from "./types"

interface RecordAiModelCallAccountingInput {
  readonly storage: AgentWorkerStorage
  readonly usage: RecordAiModelCallInput
  readonly pricingContext: AiPricingContext
  readonly ratedAt: Date
  readonly reconcileLimitReservation?: boolean
}

interface AiAccountingCapabilities {
  readonly aiUsage: AiUsageStorage
  readonly aiCosts: AiCostStorage
  readonly aiLimits: AiLimitStorage
}

let modelsDevRater: Promise<typeof import("./models-dev/pricing")> | undefined

/** Atomically append usage and a valuation from this worker's lazily loaded pricing snapshot. */
export async function recordAiModelCallAccounting(
  input: RecordAiModelCallAccountingInput
): Promise<RecordAiModelCallResult> {
  const { rateAiModelCall } = await loadModelsDevRater()
  return input.storage.transaction(async (tx) => {
    const { aiUsage, aiCosts, aiLimits } = requireAccountingCapabilities(tx)
    const usage = await aiUsage.recordModelCall(input.usage)
    const cost = rateAiModelCall({
      usage: usage.record,
      pricingContext: input.pricingContext,
      ratedAt: input.ratedAt,
    })
    await aiCosts.recordModelCallCost(cost)
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

function loadModelsDevRater(): Promise<typeof import("./models-dev/pricing")> {
  modelsDevRater ??= import("./models-dev/pricing")
  return modelsDevRater
}

function requireAccountingCapabilities(storage: Storage): AiAccountingCapabilities {
  if (!storage.aiUsage || !storage.aiCosts || !storage.aiLimits) {
    throw new Error(
      "[SixbAgentWorker] AI model-call accounting requires storage.aiUsage, storage.aiCosts, and storage.aiLimits."
    )
  }
  return { aiUsage: storage.aiUsage, aiCosts: storage.aiCosts, aiLimits: storage.aiLimits }
}
