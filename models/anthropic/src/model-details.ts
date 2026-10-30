import type { JsonObject, ModelRateCard, ModelTokenPrice } from "@sixb/core/models"

interface OutputLimitRule {
  readonly match: RegExp
  readonly maxOutputTokens: number
}

// The Messages API requires max_tokens, so the synchronous adapter needs the operational limit
// without turning every inference into a catalog request. Unknown Claude IDs are assumed to be
// newer; non-Claude IDs require an explicit limit instead of inheriting an invented default.
const OUTPUT_LIMITS: readonly OutputLimitRule[] = [
  {
    match: /claude-(?:fable|mythos|opus|sonnet)-5(?:-|$)/,
    maxOutputTokens: 128_000,
  },
  {
    match: /claude-(?:opus-4-(?:8|7|6)|sonnet-4-6)(?:-|$)/,
    maxOutputTokens: 128_000,
  },
  {
    match: /claude-(?:opus|sonnet|haiku)-4-5(?:-|$)/,
    maxOutputTokens: 64_000,
  },
  { match: /claude-opus-4-1(?:-|$)/, maxOutputTokens: 32_000 },
  { match: /claude-sonnet-4(?:-|$)/, maxOutputTokens: 64_000 },
  { match: /claude-opus-4(?:-|$)/, maxOutputTokens: 32_000 },
  {
    match: /claude-(?:instant(?:-|$)|v?2(?=$|[-.:])|3(?=$|[-.]))/,
    maxOutputTokens: 4_096,
  },
]

// Base prices come from models.dev when a model is resolved. Everything else follows Anthropic's
// published multipliers rather than per-model entries:
// https://platform.claude.com/docs/en/about-claude/pricing
/** One-hour cache writes cost twice the base input price on every model. */
const ONE_HOUR_CACHE_WRITE = [2n, 1n] as const
/** US-only inference (`inference_geo: "us"`) costs 1.1x on Claude 4.6 and later. */
const US_INFERENCE = [11n, 10n] as const
/** Fast mode doubles every meter on the models that offer it. */
const FAST_MODE = [2n, 1n] as const

// Neither models.dev nor Anthropic's Models API says which models offer fast mode.
const FAST_MODE_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"])

// US-only inference started with Claude 4.6; earlier models have no published residency price.
const PRE_US_INFERENCE = /^claude-(?:3-|[a-z]+-4(?:-[015])?(?:-\d{8})?$)/

// Unknown request dimensions may change billing. Keep inference usable but decline the estimate.
const PRICED_REQUEST_KEYS = new Set([
  "temperature",
  "top_p",
  "top_k",
  "stop_sequences",
  "metadata",
  "output_config",
  "cache_control",
  "speed",
  "inference_geo",
])

export function anthropicMaxOutputTokens(modelId: string): number | undefined {
  const known = OUTPUT_LIMITS.find((candidate) => candidate.match.test(modelId))
  if (known) return known.maxOutputTokens
  return modelId.includes("claude-") ? 128_000 : undefined
}

/**
 * The rate card for a model and its request options. `base` holds the models.dev prices, whose
 * `cacheWriteInput` is the five-minute write; one-hour writes, fast mode and US-only inference
 * are derived from it. Unknown request dimensions are unpriceable rather than guessed.
 */
export function anthropicRateCard(
  modelId: string,
  request: JsonObject | undefined,
  base: ModelRateCard | undefined
): ModelRateCard | undefined {
  if (!base?.input || !base.output) return undefined
  if (Object.keys(request ?? {}).some((key) => !PRICED_REQUEST_KEYS.has(key))) return undefined
  if (request?.speed !== undefined && request.speed !== "standard" && request.speed !== "fast")
    return undefined
  if (
    request?.inference_geo !== undefined &&
    request.inference_geo !== "global" &&
    request.inference_geo !== "us"
  )
    return undefined
  const fast = request?.speed === "fast"
  if (fast && !FAST_MODE_MODELS.has(modelId)) return undefined
  const residency = request?.inference_geo === "us"
  if (residency && PRE_US_INFERENCE.test(modelId)) return undefined

  const adjusted = (price: ModelTokenPrice) => {
    const withSpeed = fast ? scalePrice(price, FAST_MODE) : price
    return residency ? scalePrice(withSpeed, US_INFERENCE) : withSpeed
  }
  return {
    currency: "USD",
    input: adjusted(base.input),
    output: adjusted(base.output),
    ...(base.cacheReadInput === undefined ? {} : { cacheReadInput: adjusted(base.cacheReadInput) }),
    ...(base.cacheWriteInput === undefined
      ? {}
      : { cacheWriteInput5m: adjusted(base.cacheWriteInput) }),
    cacheWriteInput1h: adjusted(scalePrice(base.input, ONE_HOUR_CACHE_WRITE)),
  }
}

function scalePrice(
  price: ModelTokenPrice,
  [numerator, denominator]: readonly [bigint, bigint]
): ModelTokenPrice {
  if (typeof price === "string") return scale(price, numerator, denominator)
  return {
    default: scale(price.default, numerator, denominator),
    tiers: price.tiers.map((tier) => ({
      ...tier,
      price: scale(tier.price, numerator, denominator),
    })),
  }
}

function scale(value: string, numerator: bigint, denominator: bigint): string {
  const [whole = "0", fraction = ""] = value.split(".")
  const precision = 9
  const factor = 10n ** BigInt(fraction.length)
  const outputFactor = 10n ** BigInt(precision)
  const scaled = (BigInt(`${whole}${fraction}`) * numerator * outputFactor) / factor / denominator
  const scaledWhole = scaled / outputFactor
  const remainder = (scaled % outputFactor).toString().padStart(precision, "0").replace(/0+$/, "")
  return remainder ? `${scaledWhole}.${remainder}` : scaledWhole.toString()
}
