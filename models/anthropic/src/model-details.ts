import type { JsonObject, LanguageModelRateCard } from "@sixb/core/models"

interface PriceRule {
  readonly match: RegExp
  readonly input: string
  readonly output: string
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

// Anthropic publishes prices by model family, while /v1/models is the source of truth for IDs.
// Keep the small family table here so pricing stays reviewable TypeScript rather than generated data.
const PRICES: readonly PriceRule[] = [
  { match: /^claude-(?:fable|mythos)-5(?:-|$)/, input: "10", output: "50" },
  { match: /^claude-opus-(?:5|4-(?:8|7|6|5))(?:-|$)/, input: "5", output: "25" },
  { match: /^claude-opus-4(?:-1)?(?:-|$)/, input: "15", output: "75" },
  { match: /^claude-sonnet-5(?:-|$)/, input: "2", output: "10" },
  { match: /^claude-sonnet-4(?:-(?:6|5))?(?:-|$)/, input: "3", output: "15" },
  { match: /^claude-haiku-4-5(?:-|$)/, input: "1", output: "5" },
  { match: /^claude-(?:3-5-haiku|haiku-3-5)(?:-|$)/, input: "0.8", output: "4" },
]

export function anthropicMaxOutputTokens(modelId: string): number | undefined {
  const known = OUTPUT_LIMITS.find((candidate) => candidate.match.test(modelId))
  if (known) return known.maxOutputTokens
  return modelId.includes("claude-") ? 128_000 : undefined
}

export function anthropicRateCard(
  modelId: string,
  request: JsonObject | undefined
): LanguageModelRateCard | undefined {
  const rule = PRICES.find((candidate) => candidate.match.test(modelId))
  if (!rule) return undefined
  return applyAnthropicRateCardModifiers(
    {
      currency: "USD",
      unit: "million-tokens",
      input: rule.input,
      output: rule.output,
      cacheReadInput: scale(rule.input, 1n, 10n),
      cacheWriteInput5m: scale(rule.input, 5n, 4n),
      cacheWriteInput1h: scale(rule.input, 2n, 1n),
    },
    modelId,
    request
  )
}

export function applyAnthropicRateCardModifiers(
  rateCard: LanguageModelRateCard,
  modelId: string,
  request: JsonObject | undefined
): LanguageModelRateCard {
  const speed = request?.speed
  const fast = speed === "fast" && /^claude-opus-(?:5|4-8)(?:-|$)/.test(modelId)
  const residency = request?.inference_geo === "us"
  const baseInput = fast ? "10" : scalarPrice(rateCard.input)
  const baseOutput = fast ? "50" : scalarPrice(rateCard.output)
  // Custom tiered definitions remain authoritative; request modifiers cannot be represented
  // honestly without transforming every tier.
  if (!baseInput || !baseOutput) return rateCard
  const input = scale(baseInput, residency ? 11n : 1n, residency ? 10n : 1n)
  const output = scale(baseOutput, residency ? 11n : 1n, residency ? 10n : 1n)
  return {
    currency: "USD",
    unit: "million-tokens",
    input,
    output,
    cacheReadInput: scale(input, 1n, 10n),
    cacheWriteInput5m: scale(input, 5n, 4n),
    cacheWriteInput1h: scale(input, 2n, 1n),
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

function scalarPrice(price: LanguageModelRateCard["input"]): string | undefined {
  return typeof price === "string" ? price : undefined
}
