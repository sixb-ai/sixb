import {
  defineModelRateCard,
  estimateModelReservation,
  type JsonObject,
  type LanguageModelRateCard,
  type ModelCostEstimator,
  type ModelUsage,
  rateModelCall,
} from "@sixb/core/models"
import { responsesUsage } from "@sixb/model-protocols/responses"
import { object } from "./util"

export function foundryUsage(raw: JsonObject | undefined, reliableReasoning: boolean): ModelUsage {
  const usage = responsesUsage(raw)
  const { reasoningOutputTokens, ...totals } = usage
  const cached = usage.cacheReadInputTokens
  const input = usage.inputTokens
  const output = usage.outputTokens
  return {
    ...totals,
    ...(input !== undefined && cached !== undefined && cached <= input && onlyTokenMeters(raw)
      ? { uncachedInputTokens: input - cached }
      : {}),
    ...(reliableReasoning && reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(reliableReasoning &&
    reasoningOutputTokens !== undefined &&
    output !== undefined &&
    reasoningOutputTokens <= output &&
    onlyTokenMeters(raw)
      ? { textOutputTokens: output - reasoningOutputTokens }
      : {}),
  }
}

export function foundryEstimator(
  card: LanguageModelRateCard | undefined,
  request: JsonObject | undefined,
  modelName?: string,
  modelVersion?: string
): ModelCostEstimator {
  const rateCard = card && defineModelRateCard(card)
  const fixed = Object.keys(request ?? {}).every((key) =>
    ["temperature", "top_p", "metadata"].includes(key)
  )
  return {
    estimateReservation: (tokens) =>
      fixed ? estimateModelReservation({ ...tokens, rateCard }) : undefined,
    estimate: ({ usage, responseModelId, route }) => {
      const actual = route?.modelId ?? responseModelId
      if (
        !fixed ||
        !onlyTokenMeters(usage.raw) ||
        (modelName && actual && actual !== modelName && actual !== `${modelName}-${modelVersion}`)
      )
        return { status: "unpriceable", reason: "missing-rate-card" }
      return rateModelCall({ usage, rateCard })
    },
  }
}

/** Unknown/new meters (notably overlapping cache writes) require a custom estimator. */
function onlyTokenMeters(raw: JsonObject | undefined): boolean {
  if (!raw) return true
  if (
    Object.keys(raw).some(
      (key) =>
        ![
          "input_tokens",
          "output_tokens",
          "total_tokens",
          "input_tokens_details",
          "output_tokens_details",
        ].includes(key)
    )
  )
    return false
  // Azure includes this meter with zero on ordinary Responses calls. Nonzero writes have
  // offering-specific billing/overlap semantics and still require a custom estimator.
  return (
    Object.entries(object(raw.input_tokens_details) ?? {}).every(
      ([key, value]) => key === "cached_tokens" || (key === "cache_write_tokens" && value === 0)
    ) &&
    Object.keys(object(raw.output_tokens_details) ?? {}).every((key) => key === "reasoning_tokens")
  )
}
