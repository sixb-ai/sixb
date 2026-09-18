import type { JsonObject, ModelUsage } from "@sixb/core/models"
import { integer, object } from "../json"

/** Messages input_tokens excludes cache reads/writes; usage updates are cumulative snapshots. */
export function messagesUsage(raw: JsonObject): ModelUsage {
  const uncached = integer(raw.input_tokens)
  const cacheReadRaw = integer(raw.cache_read_input_tokens)
  const cacheWriteRaw = integer(raw.cache_creation_input_tokens)
  const cacheCreation = object(raw.cache_creation)
  const cacheWrite5mRaw = integer(cacheCreation?.ephemeral_5m_input_tokens)
  const cacheWrite1hRaw = integer(cacheCreation?.ephemeral_1h_input_tokens)
  const cacheRead = cacheReadRaw ?? (uncached === undefined ? undefined : 0)
  const cacheWrite =
    cacheWriteRaw ??
    (cacheWrite5mRaw === undefined && cacheWrite1hRaw === undefined
      ? uncached === undefined
        ? undefined
        : 0
      : (cacheWrite5mRaw ?? 0) + (cacheWrite1hRaw ?? 0))
  const hasExactCacheWriteBreakdown =
    cacheWrite5mRaw !== undefined || cacheWrite1hRaw !== undefined || cacheWrite === 0
  const cacheWrite5m = hasExactCacheWriteBreakdown ? (cacheWrite5mRaw ?? 0) : undefined
  const cacheWrite1h = hasExactCacheWriteBreakdown ? (cacheWrite1hRaw ?? 0) : undefined
  const outputTokens = integer(raw.output_tokens)
  const reasoning = integer(object(raw.output_tokens_details)?.thinking_tokens)
  const inputTokens =
    uncached === undefined && cacheRead === undefined && cacheWrite === undefined
      ? undefined
      : (uncached ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(uncached === undefined ? {} : { uncachedInputTokens: uncached }),
    ...(cacheRead === undefined ? {} : { cacheReadInputTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteInputTokens: cacheWrite }),
    ...(cacheWrite5m === undefined ? {} : { cacheWrite5mInputTokens: cacheWrite5m }),
    ...(cacheWrite1h === undefined ? {} : { cacheWrite1hInputTokens: cacheWrite1h }),
    ...(outputTokens === undefined
      ? {}
      : { textOutputTokens: Math.max(0, outputTokens - (reasoning ?? 0)) }),
    ...(reasoning === undefined ? {} : { reasoningOutputTokens: reasoning }),
    raw,
  }
}
