import type {
  JsonObject,
  LanguageModelRateCard,
  ModelCostEstimator,
  ModelUsage,
} from "@sixb/core/models"
import { foundryEstimator, foundryUsage } from "./accounting"
import { object } from "./util"

function withoutZeroMeters(
  value: JsonObject[string],
  names: readonly string[]
): JsonObject[string] {
  const details = object(value)
  if (!details) return value
  return Object.fromEntries(
    Object.entries(details).filter(([key, count]) => !names.includes(key) || count !== 0)
  )
}

/** Translate only counter names; keep unknown meters visible to conservative Responses accounting. */
function counters(raw: JsonObject | undefined): JsonObject | undefined {
  if (!raw) return undefined
  const {
    prompt_tokens,
    completion_tokens,
    prompt_tokens_details,
    completion_tokens_details,
    total_tokens,
    ...rest
  } = raw
  return {
    ...(Object.keys(rest).length ? { unrecognized_chat_meters: rest } : {}),
    ...(total_tokens === undefined ? {} : { total_tokens }),
    ...(prompt_tokens === undefined ? {} : { input_tokens: prompt_tokens }),
    ...(completion_tokens === undefined ? {} : { output_tokens: completion_tokens }),
    ...(prompt_tokens_details === undefined
      ? {}
      : { input_tokens_details: withoutZeroMeters(prompt_tokens_details, ["audio_tokens"]) }),
    ...(completion_tokens_details === undefined
      ? {}
      : {
          output_tokens_details: withoutZeroMeters(completion_tokens_details, [
            "audio_tokens",
            "accepted_prediction_tokens",
            "rejected_prediction_tokens",
          ]),
        }),
  }
}

export function foundryChatUsage(
  raw: JsonObject | undefined,
  reliableReasoning: boolean
): ModelUsage {
  const { raw: _translated, ...usage } = foundryUsage(counters(raw), reliableReasoning)
  return { ...usage, ...(raw ? { raw } : {}) }
}

export function foundryChatEstimator(
  card: LanguageModelRateCard | undefined,
  request: JsonObject | undefined,
  modelName?: string,
  modelVersion?: string
): ModelCostEstimator {
  const estimator = foundryEstimator(card, request, modelName, modelVersion)
  return {
    estimateReservation: estimator.estimateReservation,
    estimate: (input) =>
      estimator.estimate({ ...input, usage: { ...input.usage, raw: counters(input.usage.raw) } }),
  }
}
