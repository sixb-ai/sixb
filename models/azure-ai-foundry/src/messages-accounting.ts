import {
  defineModelRateCard,
  estimateModelReservation,
  type JsonObject,
  type LanguageModelRateCard,
  type ModelCostEstimator,
  type ModelUsage,
  rateModelCall,
} from "@sixb/core/models"
import { object } from "./util"

/** Native Messages counters are additive; absent cache/thinking counters stay unknown. */
export function foundryMessagesUsage(raw: JsonObject): ModelUsage {
  const uncached = counter(raw.input_tokens)
  const read = counter(raw.cache_read_input_tokens)
  const creation = object(raw.cache_creation)
  const five = counter(creation?.ephemeral_5m_input_tokens)
  const hour = counter(creation?.ephemeral_1h_input_tokens)
  const write =
    counter(raw.cache_creation_input_tokens) ??
    (five !== undefined && hour !== undefined ? five + hour : undefined)
  const output = counter(raw.output_tokens)
  const thinking = counter(object(raw.output_tokens_details)?.thinking_tokens)
  const input =
    uncached !== undefined && read !== undefined && write !== undefined
      ? uncached + read + write
      : undefined
  return {
    ...(input === undefined ? {} : { inputTokens: input }),
    ...(uncached === undefined ? {} : { uncachedInputTokens: uncached }),
    ...(read === undefined ? {} : { cacheReadInputTokens: read }),
    ...(write === undefined ? {} : { cacheWriteInputTokens: write }),
    ...(five === undefined && write !== 0 ? {} : { cacheWrite5mInputTokens: five ?? 0 }),
    ...(hour === undefined && write !== 0 ? {} : { cacheWrite1hInputTokens: hour ?? 0 }),
    ...(output === undefined ? {} : { outputTokens: output }),
    ...(thinking === undefined ? {} : { reasoningOutputTokens: thinking }),
    ...(output !== undefined && thinking !== undefined && thinking <= output
      ? { textOutputTokens: output - thinking }
      : {}),
    raw,
  }
}

export function foundryMessagesEstimator(
  card: LanguageModelRateCard | undefined,
  request: JsonObject | undefined,
  modelName?: string
): ModelCostEstimator {
  const rateCard = card && defineModelRateCard(card)
  const fixed = Object.keys(request ?? {}).every((key) =>
    ["temperature", "top_p", "top_k", "metadata", "stop_sequences", "cache_control"].includes(key)
  )
  return {
    estimateReservation: (tokens) =>
      fixed ? estimateModelReservation({ ...tokens, rateCard }) : undefined,
    estimate: ({ usage, responseModelId, route }) => {
      const actual = route?.modelId ?? responseModelId
      // Foundry's Claude version 1/2 describes hosting, not a publisher response-model suffix.
      if (!fixed || !tokenMeters(usage.raw) || (modelName && actual && actual !== modelName))
        return { status: "unpriceable", reason: "missing-rate-card" }
      return rateModelCall({ usage, rateCard })
    },
  }
}

function counter(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function tokenMeters(raw: JsonObject | undefined): boolean {
  if (!raw) return true
  const numeric = [
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
  ]
  for (const [key, value] of Object.entries(raw)) {
    if (numeric.includes(key)) {
      if (counter(value) === undefined) return false
    } else if (key === "cache_creation" || key === "output_tokens_details") {
      const details = object(value)
      const allowed =
        key === "cache_creation"
          ? ["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"]
          : ["thinking_tokens"]
      if (
        !details ||
        Object.entries(details).some(([k, v]) => !allowed.includes(k) || counter(v) === undefined)
      )
        return false
    } else if (key === "server_tool_use") {
      const tools = object(value)
      if (
        !tools ||
        Object.entries(tools).some(
          ([k, v]) => !["web_search_requests", "web_fetch_requests"].includes(k) || v !== 0
        )
      )
        return false
    } else if (key === "service_tier" && value === "standard") {
    } else return false
  }
  return true
}
