import type {
  JsonObject,
  LanguageModelRateCard,
  ModelCostEstimator,
  ModelUsage,
} from "@sixb/core/models"
import { tokenEstimator } from "./accounting"
import { counter, object } from "./util"

// Interpret Chat counters directly. Cache reads overlap prompt_tokens; reasoning overlaps
// completion_tokens. A missing partition is unknown, even when a rate card supplies its price.
export function foundryChatUsage(
  raw: JsonObject | undefined,
  reliableReasoning: boolean | undefined
): ModelUsage {
  const input = counter(raw?.prompt_tokens)
  const output = counter(raw?.completion_tokens)
  const read = counter(object(raw?.prompt_tokens_details)?.cached_tokens)
  const reported = reasoningTokens(raw)
  const reasoning =
    reported !== undefined &&
    reported !== false &&
    (reliableReasoning === true || (reliableReasoning === undefined && reported > 0))
      ? reported
      : undefined
  const known = tokenMeters(raw)
  return {
    ...(input === undefined ? {} : { inputTokens: input }),
    ...(output === undefined ? {} : { outputTokens: output }),
    ...(read === undefined ? {} : { cacheReadInputTokens: read }),
    ...(object(raw?.prompt_tokens_details)?.cache_write_tokens === 0
      ? { cacheWriteInputTokens: 0 }
      : {}),
    ...(input !== undefined && read !== undefined && read <= input && known
      ? { uncachedInputTokens: input - read }
      : {}),
    ...(reasoning === undefined ? {} : { reasoningOutputTokens: reasoning }),
    ...(output !== undefined && reasoning !== undefined && reasoning <= output && known
      ? { textOutputTokens: output - reasoning }
      : {}),
    ...(raw ? { raw } : {}),
  }
}

export function foundryChatEstimator(
  card: LanguageModelRateCard | undefined,
  request: JsonObject | undefined,
  modelName?: string,
  modelVersion?: string,
  aliases?: readonly string[]
): ModelCostEstimator {
  const estimator = tokenEstimator(
    card,
    request,
    ["temperature", "top_p", "metadata"],
    tokenMeters,
    modelName,
    modelVersion,
    aliases
  )
  return {
    estimateReservation: estimator.estimateReservation,
    estimate: (input) =>
      estimator.estimate({
        ...input,
        usage: { ...foundryChatUsage(input.usage.raw, false), ...input.usage },
      }),
  }
}

function tokenMeters(raw: JsonObject | undefined): boolean {
  if (!raw) return true
  if (reasoningTokens(raw) === false) return false
  for (const [key, value] of Object.entries(raw)) {
    if (["prompt_tokens", "completion_tokens", "total_tokens"].includes(key)) {
      if (counter(value) === undefined) return false
    } else if (
      key === "prompt_tokens_details" ||
      key === "completion_tokens_details" ||
      key === "output_tokens_details"
    ) {
      if (value === null) continue
      const details = object(value)
      if (!details) return false
      for (const [meter, count] of Object.entries(details)) {
        if (
          (key === "prompt_tokens_details" && meter === "cached_tokens") ||
          (key !== "prompt_tokens_details" && meter === "reasoning_tokens")
        ) {
          if (counter(count) === undefined) return false
        } else if (key === "prompt_tokens_details" && meter === "image_tokens") {
          // Image tokens are already included in prompt_tokens, at the input token rate.
          const image = counter(count)
          const input = counter(raw.prompt_tokens)
          if (image === undefined || input === undefined || image > input) return false
        } else if (
          ![
            "audio_tokens",
            ...(key === "prompt_tokens_details"
              ? ["cache_write_tokens"]
              : ["accepted_prediction_tokens", "rejected_prediction_tokens"]),
          ].includes(meter) ||
          count !== 0
        )
          return false
      }
    } else if (key !== "reasoning_tokens") return false
  }
  return true
}

// Azure Chat backends may repeat the same reasoning partition in Responses-style
// details or at the top level. Accept only valid, consistent aliases within the total.
function reasoningTokens(raw: JsonObject | undefined): number | undefined | false {
  let result: number | undefined
  for (const value of [
    object(raw?.completion_tokens_details)?.reasoning_tokens,
    object(raw?.output_tokens_details)?.reasoning_tokens,
    raw?.reasoning_tokens,
  ]) {
    if (value === undefined) continue
    const count = counter(value)
    const output = counter(raw?.completion_tokens)
    if (
      count === undefined ||
      output === undefined ||
      count > output ||
      (result !== undefined && result !== count)
    )
      return false
    result = count
  }
  return result
}
