import type { JsonObject, LanguageModelRateCard } from "@sixb/core/models"

interface TokenRates {
  readonly input: string
  readonly output: string
  readonly cacheReadInput: string
  readonly cacheWriteInput5m: string
  readonly cacheWriteInput1h: string
}

interface PriceRule {
  readonly modelIds: readonly string[]
  readonly rates: TokenRates
  readonly usInference?: boolean
}

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

// Public USD/MTok prices verified on 2026-09-07:
// https://platform.claude.com/docs/en/about-claude/pricing
// Exact IDs only: neither new versions nor dated snapshots inherit a guessed family price.
// Applied rates are retained by the accounting ledger; these are estimates, not negotiated bills.
const PRICES: readonly PriceRule[] = [
  {
    modelIds: ["claude-fable-5-1", "claude-mythos-5-1"],
    rates: {
      input: "10",
      output: "50",
      cacheReadInput: "0.25",
      cacheWriteInput5m: "12.5",
      cacheWriteInput1h: "20",
    },
    usInference: true,
  },
  {
    modelIds: ["claude-fable-5", "claude-mythos-5"],
    rates: {
      input: "10",
      output: "50",
      cacheReadInput: "1",
      cacheWriteInput5m: "12.5",
      cacheWriteInput1h: "20",
    },
    usInference: true,
  },
  {
    modelIds: ["claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6"],
    rates: {
      input: "5",
      output: "25",
      cacheReadInput: "0.5",
      cacheWriteInput5m: "6.25",
      cacheWriteInput1h: "10",
    },
    usInference: true,
  },
  {
    modelIds: ["claude-opus-4-5"],
    rates: {
      input: "5",
      output: "25",
      cacheReadInput: "0.5",
      cacheWriteInput5m: "6.25",
      cacheWriteInput1h: "10",
    },
  },
  {
    modelIds: ["claude-opus-4", "claude-opus-4-1"],
    rates: {
      input: "15",
      output: "75",
      cacheReadInput: "1.5",
      cacheWriteInput5m: "18.75",
      cacheWriteInput1h: "30",
    },
  },
  {
    modelIds: ["claude-sonnet-5"],
    rates: {
      input: "2",
      output: "10",
      cacheReadInput: "0.2",
      cacheWriteInput5m: "2.5",
      cacheWriteInput1h: "4",
    },
    usInference: true,
  },
  {
    modelIds: ["claude-sonnet-4-6"],
    rates: {
      input: "3",
      output: "15",
      cacheReadInput: "0.3",
      cacheWriteInput5m: "3.75",
      cacheWriteInput1h: "6",
    },
    usInference: true,
  },
  {
    modelIds: ["claude-sonnet-4", "claude-sonnet-4-5"],
    rates: {
      input: "3",
      output: "15",
      cacheReadInput: "0.3",
      cacheWriteInput5m: "3.75",
      cacheWriteInput1h: "6",
    },
  },
  {
    modelIds: ["claude-haiku-4-5"],
    rates: {
      input: "1",
      output: "5",
      cacheReadInput: "0.1",
      cacheWriteInput5m: "1.25",
      cacheWriteInput1h: "2",
    },
  },
  {
    modelIds: ["claude-3-5-haiku"],
    rates: {
      input: "0.8",
      output: "4",
      cacheReadInput: "0.08",
      cacheWriteInput5m: "1",
      cacheWriteInput1h: "1.6",
    },
  },
]

const FAST_RATES: TokenRates = {
  input: "10",
  output: "50",
  cacheReadInput: "1",
  cacheWriteInput5m: "12.5",
  cacheWriteInput1h: "20",
}

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

export function anthropicRateCard(
  modelId: string,
  request: JsonObject | undefined
): LanguageModelRateCard | undefined {
  const rule = PRICES.find((candidate) => candidate.modelIds.includes(modelId))
  if (!rule) return undefined
  if (Object.keys(request ?? {}).some((key) => !PRICED_REQUEST_KEYS.has(key))) return undefined
  if (request?.speed !== undefined && request.speed !== "standard" && request.speed !== "fast")
    return undefined
  if (
    request?.inference_geo !== undefined &&
    request.inference_geo !== "global" &&
    request.inference_geo !== "us"
  )
    return undefined
  if (request?.inference_geo !== undefined && !rule.usInference) return undefined
  const fast = request?.speed === "fast"
  if (fast && modelId !== "claude-opus-5" && modelId !== "claude-opus-4-8") return undefined
  const rates = fast ? FAST_RATES : rule.rates
  const residency = request?.inference_geo === "us"
  const adjusted = (value: string) => (residency ? scale(value, 11n, 10n) : value)
  return {
    currency: "USD",
    unit: "million-tokens",
    input: adjusted(rates.input),
    output: adjusted(rates.output),
    cacheReadInput: adjusted(rates.cacheReadInput),
    cacheWriteInput5m: adjusted(rates.cacheWriteInput5m),
    cacheWriteInput1h: adjusted(rates.cacheWriteInput1h),
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
