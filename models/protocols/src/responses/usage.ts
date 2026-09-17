import type { JsonObject, ModelUsage } from "@sixb/core/models"
import { integer, object } from "../json"

/** Map the reported Responses counters without inferring absent usage partitions. */
export function responsesUsage(raw: JsonObject | undefined): ModelUsage {
  if (!raw) return {}
  const inputTokens = integer(raw.input_tokens)
  const outputTokens = integer(raw.output_tokens)
  const cached = integer(object(raw.input_tokens_details)?.cached_tokens)
  const reasoning = integer(object(raw.output_tokens_details)?.reasoning_tokens)
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cached === undefined ? {} : { cacheReadInputTokens: cached }),
    ...(reasoning === undefined ? {} : { reasoningOutputTokens: reasoning }),
    raw,
  }
}
