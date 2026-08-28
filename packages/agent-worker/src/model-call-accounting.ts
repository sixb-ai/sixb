import type {
  AiCostStorage,
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
}

interface AiAccountingCapabilities {
  readonly aiUsage: AiUsageStorage
  readonly aiCosts: AiCostStorage
}

let modelsDevRater: Promise<typeof import("./models-dev/pricing")> | undefined

/** Atomically append usage and a valuation from this worker's lazily loaded pricing snapshot. */
export async function recordAiModelCallAccounting(
  input: RecordAiModelCallAccountingInput
): Promise<RecordAiModelCallResult> {
  const { rateAiModelCall } = await loadModelsDevRater()
  return input.storage.transaction(async (tx) => {
    const { aiUsage, aiCosts } = requireAccountingCapabilities(tx)
    const usage = await aiUsage.recordModelCall(input.usage)
    const cost = rateAiModelCall({
      usage: usage.record,
      pricingContext: input.pricingContext,
      ratedAt: input.ratedAt,
    })
    await aiCosts.recordModelCallCost(cost)
    return usage
  })
}

function loadModelsDevRater(): Promise<typeof import("./models-dev/pricing")> {
  modelsDevRater ??= import("./models-dev/pricing")
  return modelsDevRater
}

function requireAccountingCapabilities(storage: Storage): AiAccountingCapabilities {
  if (!storage.aiUsage || !storage.aiCosts) {
    throw new Error(
      "[SixbAgentWorker] AI model-call accounting requires storage.aiUsage and storage.aiCosts."
    )
  }
  return { aiUsage: storage.aiUsage, aiCosts: storage.aiCosts }
}
