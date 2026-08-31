import type { LanguageModelPricing, ModelTokenPrice } from "./definitions"
import type { ModelUsage } from "./events"

export interface ModelMoney {
  readonly currency: "USD"
  /** Billionths of one currency unit, serialized as an integer string. */
  readonly amountNanos: string
}

export interface ModelReportedCost {
  readonly money: ModelMoney
  readonly providerId?: string
}

export type ModelCallCost =
  | { readonly status: "reported"; readonly money: ModelMoney; readonly providerId?: string }
  | { readonly status: "rated"; readonly money: ModelMoney }
  | {
      readonly status: "unpriceable"
      readonly reason: "missing-pricing" | "missing-usage" | "inconsistent-usage"
    }

/** Prefer the provider's bill over catalog estimates, then rate exact token meters locally. */
export function priceModelCall(input: {
  readonly usage: ModelUsage
  readonly pricing?: LanguageModelPricing
  readonly reported?: ModelReportedCost
}): ModelCallCost {
  if (input.reported) {
    assertAmountNanos(input.reported.money.amountNanos)
    return {
      status: "reported",
      money: input.reported.money,
      ...(input.reported.providerId === undefined ? {} : { providerId: input.reported.providerId }),
    }
  }
  if (!input.pricing) return { status: "unpriceable", reason: "missing-pricing" }
  const { usage, pricing } = input
  if (usage.inputTokens === undefined || usage.outputTokens === undefined) {
    return { status: "unpriceable", reason: "missing-usage" }
  }
  if (!isValidUsage(usage)) {
    return { status: "unpriceable", reason: "inconsistent-usage" }
  }

  const cacheRead = usage.cacheReadInputTokens ?? 0
  const cacheWrite = usage.cacheWriteInputTokens ?? 0
  const uncached =
    usage.uncachedInputTokens ?? Math.max(0, usage.inputTokens - cacheRead - cacheWrite)
  const nanos =
    rateTokens(uncached, resolvePrice(pricing.input, usage.inputTokens)) +
    rateTokens(
      cacheRead,
      resolvePrice(pricing.cacheReadInput ?? pricing.input, usage.inputTokens)
    ) +
    rateTokens(
      cacheWrite,
      resolvePrice(pricing.cacheWriteInput ?? pricing.input, usage.inputTokens)
    ) +
    rateTokens(usage.outputTokens, resolvePrice(pricing.output, usage.inputTokens))
  return { status: "rated", money: { currency: pricing.currency, amountNanos: nanos.toString() } }
}

function isValidUsage(usage: ModelUsage): boolean {
  const counts = Object.entries(usage).filter(([key]) => key !== "raw")
  if (
    counts.some(([, value]) => value !== undefined && (!Number.isSafeInteger(value) || value < 0))
  ) {
    return false
  }

  const input = usage.inputTokens
  const output = usage.outputTokens
  if (input === undefined || output === undefined) return false
  const cacheRead = usage.cacheReadInputTokens ?? 0
  const cacheWrite = usage.cacheWriteInputTokens ?? 0
  const uncached = usage.uncachedInputTokens
  // Provider detail meters are not universally disjoint. Trust an explicit uncached count; only
  // reject a breakdown when we would otherwise have to derive a negative uncached count.
  return uncached !== undefined || cacheRead + cacheWrite <= input
}

function resolvePrice(price: ModelTokenPrice, tokens: number): string {
  if (typeof price === "string") return price
  return (
    price.tiers.find(
      (tier) =>
        tokens >= tier.minTokens && (tier.maxTokens === undefined || tokens < tier.maxTokens)
    )?.price ?? price.default
  )
}

function rateTokens(tokens: number, pricePerMillion: string): bigint {
  const [whole = "0", fraction = ""] = pricePerMillion.split(".")
  const scale = 10n ** BigInt(fraction.length)
  const price = BigInt(`${whole}${fraction}`)
  const numerator = BigInt(tokens) * price * 1_000n
  return (numerator + scale / 2n) / scale
}

function assertAmountNanos(value: string): void {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new TypeError("[Sixb] Provider-reported model cost must use nonnegative amountNanos.")
  }
}
