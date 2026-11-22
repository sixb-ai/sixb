import {
  defineModelRateCard,
  estimateModelReservation,
  type JsonObject,
  type ModelCostEstimator,
  type ModelRateCard,
  type ModelUsage,
  rateModelCall,
} from "@sixb/core/models"
import { responsesUsage } from "@sixb/model-protocols/responses"
import { counter, object } from "./util"

export function foundryUsage(
  raw: JsonObject | undefined,
  reliableReasoning: boolean | undefined
): ModelUsage {
  const usage = responsesUsage(raw)
  const { reasoningOutputTokens, ...totals } = usage
  const cached = usage.cacheReadInputTokens
  // GPT-5.6 and later bill a cache write in place of ordinary input: input tokens are uncached,
  // read or written, each once (measured on Azure: 7,546 input, 7,543 written, 0 read).
  const written = counter(object(raw?.input_tokens_details)?.cache_write_tokens)
  const input = usage.inputTokens
  const output = usage.outputTokens
  const knownReasoning =
    reasoningOutputTokens !== undefined &&
    output !== undefined &&
    reasoningOutputTokens <= output &&
    (reliableReasoning === true || (reliableReasoning === undefined && reasoningOutputTokens > 0))
  return {
    ...totals,
    ...(written === undefined ? {} : { cacheWriteInputTokens: written }),
    ...(input !== undefined &&
    cached !== undefined &&
    cached + (written ?? 0) <= input &&
    onlyTokenMeters(raw)
      ? { uncachedInputTokens: input - cached - (written ?? 0) }
      : {}),
    ...(knownReasoning ? { reasoningOutputTokens } : {}),
    ...(knownReasoning &&
    reasoningOutputTokens !== undefined &&
    output !== undefined &&
    reasoningOutputTokens <= output &&
    onlyTokenMeters(raw)
      ? { textOutputTokens: output - reasoningOutputTokens }
      : {}),
  }
}

/** An estimator, with the card it prices by when it prices this configuration at all. */
export type PricedEstimator = ModelCostEstimator & { readonly rateCard?: ModelRateCard }

export function foundryEstimator(
  card: ModelRateCard | undefined,
  request: JsonObject | undefined,
  modelName?: string,
  modelVersion?: string,
  aliases?: readonly string[]
): PricedEstimator {
  return tokenEstimator(
    card,
    request,
    ["temperature", "top_p", "metadata"],
    onlyTokenMeters,
    modelName,
    modelVersion,
    aliases
  )
}

export function tokenEstimator(
  card: ModelRateCard | undefined,
  request: JsonObject | undefined,
  requestKeys: readonly string[],
  tokenMeters: (raw: JsonObject | undefined) => boolean,
  modelName?: string,
  modelVersion?: string,
  aliases?: readonly string[]
): PricedEstimator {
  const rateCard = card && defineModelRateCard(card)
  const fixed = Object.keys(request ?? {}).every((key) => requestKeys.includes(key))
  return {
    ...(fixed && rateCard ? { rateCard } : {}),
    estimateReservation: (tokens) =>
      fixed ? estimateModelReservation({ ...tokens, rateCard }) : undefined,
    estimate: ({ usage, responseModelId, route }) => {
      const actual = route?.modelId ?? responseModelId
      if (
        !fixed ||
        !tokenMeters(usage.raw) ||
        (modelName &&
          actual &&
          !(aliases ?? [modelName, `${modelName}-${modelVersion}`]).includes(actual))
      )
        return { status: "unpriceable", reason: "missing-rate-card" }
      return rateModelCall({ usage, rateCard })
    },
  }
}

/** Unknown or new meters require a custom estimator. */
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
  return (
    Object.entries(object(raw.input_tokens_details) ?? {}).every(
      ([key, value]) =>
        key === "cached_tokens" ||
        key === "cache_write_tokens" ||
        (key === "cache_write_tokens_details" && defaultLifetimeWrites(value))
    ) &&
    Object.keys(object(raw.output_tokens_details) ?? {}).every((key) => key === "reasoning_tokens")
  )
}

/**
 * Writes by cache lifetime, as GPT-5.6 and later report them. The catalog's write rate is the
 * default 30 minutes'; a 12-hour write costs twice that, so any makes the call unpriceable.
 */
export function defaultLifetimeWrites(details: unknown): boolean {
  const lifetimes = object(details)
  return (
    lifetimes !== undefined &&
    Object.entries(lifetimes).every(
      ([key, value]) =>
        (key === "ttl_30m_tokens" && counter(value) !== undefined) ||
        (key === "ttl_12h_tokens" && value === 0)
    )
  )
}
