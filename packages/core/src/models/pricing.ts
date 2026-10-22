import type { ModelRoute, ModelUsage } from "./events"
import {
  type ModelPricingDimensions,
  type ModelRateCard,
  type ModelTokenPrice,
  type ModelVariantPrice,
  modelVariantPrices,
  resolveModelVariantPrice,
} from "./rate-card"

/** Optional local financial enrichment cannot discard a completed, billable call. */
export function estimateModelCall(
  model: { readonly costEstimator?: Pick<ModelCostEstimator, "estimate"> },
  input: Parameters<ModelCostEstimator["estimate"]>[0]
): ModelCostEstimate {
  try {
    return model.costEstimator?.estimate(input) ?? rateModelCall({ usage: input.usage })
  } catch {
    console.warn(
      "[Sixb] Model cost estimation failed; preserving usage and available provider cost."
    )
    return { status: "unpriceable", reason: "missing-rate-card" }
  }
}

export interface ModelMoney {
  readonly currency: "USD"
  /** Billionths of one currency unit, serialized as an integer string. */
  readonly amountNanos: string
}

export interface ModelReportedCost {
  readonly money: ModelMoney
  readonly providerId?: string
}

/** A local estimate is never a provider-reported charge. No financial API is required to run. */
export type ModelCostEstimate = Exclude<ModelCallCost, { status: "reported" }>

export interface ModelCostEstimator {
  /** Conservative token-cost reservation, including cache writes and pricing tiers.
   * Return undefined when routing or non-token charges prevent a safe local estimate. */
  estimateReservation?(input: {
    readonly inputTokens: number
    readonly outputTokens: number
  }): ModelMoney | undefined

  estimate(input: {
    readonly usage: ModelUsage
    readonly route?: ModelRoute
    readonly responseModelId?: string
    /** The request's size, quality, style or voice tier, for prices that vary with them. */
    readonly dimensions?: ModelPricingDimensions
  }): ModelCostEstimate
}

export type ModelCostMeter =
  | "audio.input.milliseconds"
  | "characters.input"
  | "images.output"
  | "tokens.input.total"
  | "tokens.input.uncached"
  | "tokens.input.cacheRead"
  | "tokens.input.cacheWrite"
  | "tokens.input.cacheWrite5m"
  | "tokens.input.cacheWrite1h"
  | "tokens.output.total"
  | "tokens.output.text"
  | "tokens.output.reasoning"
  | "tokens.output.image"
  | "tokens.output.audio"

export interface ModelCostComponent {
  readonly meter: ModelCostMeter
  readonly quantity: string
  readonly rateAmountNanosPerMillion: string
  readonly chargeAmountNanos: string
  /** The price variant that applied, such as `1024x1024 · high`. Display only. */
  readonly variant?: string
}

export type ModelCallCost =
  | { readonly status: "reported"; readonly money: ModelMoney; readonly providerId?: string }
  | {
      readonly status: "rated"
      readonly money: ModelMoney
      readonly components: readonly ModelCostComponent[]
    }
  | {
      readonly status: "unpriceable"
      readonly reason:
        | "missing-rate-card"
        | "missing-usage"
        | "inconsistent-usage"
        | "unsupported-pricing-dimension"
      readonly missingMeters?: readonly ModelCostMeter[]
    }

type Unpriceable = Extract<ModelCallCost, { status: "unpriceable" }>

type TokenRateCard = ModelRateCard & {
  readonly input: ModelTokenPrice
  readonly output: ModelTokenPrice
}

function pricesTokens(card: ModelRateCard): card is TokenRateCard {
  return card.input !== undefined && card.output !== undefined
}

/**
 * Reserve at the highest rates the request could be billed at, before cache usage, the final tier
 * and the produced media are known. Undefined when a meter the card bills has no bound.
 */
export function estimateModelReservation(input: {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly outputImages?: number
  readonly inputCharacters?: number
  readonly dimensions?: ModelPricingDimensions
  readonly rateCard?: ModelRateCard
}): ModelMoney | undefined {
  if (!input.rateCard) return undefined
  const counts = [input.inputTokens, input.outputTokens, input.outputImages, input.inputCharacters]
  if (!counts.every((n) => n === undefined || (Number.isSafeInteger(n) && n >= 0))) {
    throw new TypeError("[Sixb] Model reservation estimates must be nonnegative safe integers.")
  }
  const maxRate = (prices: readonly (ModelTokenPrice | undefined)[]) => {
    const rates = prices.flatMap((price) =>
      price === undefined
        ? []
        : typeof price === "string"
          ? [price]
          : [price.default, ...price.tiers.map((tier) => tier.price)]
    )
    return highestRate(rates)
  }
  const card = input.rateCard
  const charge = (quantity: number, rate: bigint) =>
    (BigInt(quantity) * rate + 999_999n) / 1_000_000n

  let total = 0n
  if (pricesTokens(card)) {
    if (input.inputTokens === undefined || input.outputTokens === undefined) return undefined
    const inputRate = maxRate([
      card.input,
      card.cacheReadInput,
      card.cacheWriteInput,
      card.cacheWriteInput5m,
      card.cacheWriteInput1h,
    ])
    const outputRate = maxRate([card.output, card.imageOutput, card.audioOutput])
    total += charge(input.inputTokens, inputRate) + charge(input.outputTokens, outputRate)
  }
  if (card.images !== undefined) {
    if (input.outputImages === undefined) return undefined
    total += BigInt(input.outputImages) * reservationPrice(card.images, input.dimensions)
  }
  if (card.characters !== undefined) {
    if (input.inputCharacters === undefined) return undefined
    total += charge(input.inputCharacters, reservationPrice(card.characters, input.dimensions))
  }
  return { currency: "USD", amountNanos: total.toString() }
}

function reservationPrice(
  price: ModelVariantPrice,
  dimensions: ModelPricingDimensions | undefined
): bigint {
  const resolved = resolveModelVariantPrice(price, dimensions)
  // The default applies to unknown dimensions; reserving it could fall short of a variant.
  return resolved?.variant !== undefined || typeof price === "string"
    ? decimalDollarsToNanos(resolved!.price)
    : highestRate(modelVariantPrices(price))
}

function highestRate(prices: readonly string[]): bigint {
  return prices.reduce((max, price) => {
    const rate = decimalDollarsToNanos(price)
    return rate > max ? rate : max
  }, 0n)
}

/**
 * Prefer the provider's bill over rate-card estimates, then rate the call locally. A call is
 * billed by tokens, by units (images, characters) or both; every quantity must be covered by one.
 */
export function rateModelCall(input: {
  readonly usage: ModelUsage
  readonly rateCard?: ModelRateCard
  readonly dimensions?: ModelPricingDimensions
  readonly reported?: undefined
}): ModelCostEstimate
export function rateModelCall(input: {
  readonly usage: ModelUsage
  readonly rateCard?: ModelRateCard
  readonly dimensions?: ModelPricingDimensions
  readonly reported?: ModelReportedCost
}): ModelCallCost
export function rateModelCall(input: {
  readonly usage: ModelUsage
  readonly rateCard?: ModelRateCard
  readonly dimensions?: ModelPricingDimensions
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
  if (!input.rateCard) return { status: "unpriceable", reason: "missing-rate-card" }
  const { usage, rateCard } = input
  if (!validUsageCounters(usage)) {
    return { status: "unpriceable", reason: "inconsistent-usage" }
  }

  const units = rateUnits(usage, rateCard, input.dimensions)
  if (!Array.isArray(units)) return units
  const tokens = pricesTokens(rateCard) ? rateTokens(usage, rateCard) : []
  if (!Array.isArray(tokens)) return tokens

  const components = [...tokens, ...units]
  const total = components.reduce((sum, entry) => sum + BigInt(entry.chargeAmountNanos), 0n)
  return {
    status: "rated",
    money: { currency: rateCard.currency, amountNanos: total.toString() },
    components,
  }
}

function rateUnits(
  usage: ModelUsage,
  rateCard: ModelRateCard,
  dimensions: ModelPricingDimensions | undefined
): ModelCostComponent[] | Unpriceable {
  // Without token prices, a count the card doesn't price is a charge nothing covers.
  if (!pricesTokens(rateCard)) {
    const unpriced: ModelCostMeter[] = [
      ...((usage.outputImages ?? 0) > 0 && rateCard.images === undefined
        ? (["images.output"] as const)
        : []),
      ...((usage.inputCharacters ?? 0) > 0 && rateCard.characters === undefined
        ? (["characters.input"] as const)
        : []),
    ]
    if (unpriced.length > 0) {
      return { status: "unpriceable", reason: "missing-rate-card", missingMeters: unpriced }
    }
  }

  const components: ModelCostComponent[] = []
  const missing: ModelCostMeter[] = []
  for (const [meter, quantity, price, perUnit] of [
    ["images.output", usage.outputImages, rateCard.images, true],
    ["characters.input", usage.inputCharacters, rateCard.characters, false],
  ] as const) {
    if (price === undefined) continue
    if (quantity === undefined) {
      missing.push(meter)
      continue
    }
    // A priced call that produced nothing keeps its zero-quantity component.
    if (quantity === 0 && pricesTokens(rateCard)) continue
    const resolved = resolveModelVariantPrice(price, dimensions) ?? (quantity === 0 ? zero : null)
    if (!resolved) return { status: "unpriceable", reason: "unsupported-pricing-dimension" }
    const rate = decimalDollarsToNanos(resolved.price) * (perUnit ? 1_000_000n : 1n)
    components.push(componentAtRate(meter, quantity, rate, resolved.variant))
  }
  if (missing.length > 0) {
    return { status: "unpriceable", reason: "missing-usage", missingMeters: missing }
  }
  return components
}

const zero: { readonly price: string; readonly variant?: string } = { price: "0" }

function rateTokens(
  usage: ModelUsage,
  rateCard: TokenRateCard
): ModelCostComponent[] | Unpriceable {
  if (usage.inputTokens === undefined || usage.outputTokens === undefined) {
    return {
      status: "unpriceable",
      reason: "missing-usage",
      missingMeters: [
        ...(usage.inputTokens === undefined ? (["tokens.input.total"] as const) : []),
        ...(usage.outputTokens === undefined ? (["tokens.output.total"] as const) : []),
      ],
    }
  }

  const partitioned = partitionInputUsage(usage, rateCard)
  if (partitioned.status !== "rated") return partitioned

  const components: ModelCostComponent[] = []
  if (!partitioned.partitioned) {
    components.push(
      component("tokens.input.total", usage.inputTokens, rateCard.input, usage.inputTokens)
    )
  } else {
    components.push(
      component("tokens.input.uncached", partitioned.uncached, rateCard.input, usage.inputTokens)
    )
    if (partitioned.cacheRead !== undefined) {
      components.push(
        component(
          "tokens.input.cacheRead",
          partitioned.cacheRead,
          rateCard.cacheReadInput!,
          usage.inputTokens
        )
      )
    }
    if (partitioned.cacheWrite !== undefined) {
      components.push(
        component(
          "tokens.input.cacheWrite",
          partitioned.cacheWrite,
          rateCard.cacheWriteInput!,
          usage.inputTokens
        )
      )
    }
    if (partitioned.cacheWrite5m !== undefined) {
      components.push(
        component(
          "tokens.input.cacheWrite5m",
          partitioned.cacheWrite5m,
          rateCard.cacheWriteInput5m ?? rateCard.cacheWriteInput!,
          usage.inputTokens
        )
      )
    }
    if (partitioned.cacheWrite1h !== undefined) {
      components.push(
        component(
          "tokens.input.cacheWrite1h",
          partitioned.cacheWrite1h,
          rateCard.cacheWriteInput1h ?? rateCard.cacheWriteInput!,
          usage.inputTokens
        )
      )
    }
  }

  const output = rateOutputTokens(usage, usage.outputTokens, usage.inputTokens, rateCard)
  if (!Array.isArray(output)) return output
  return [...components, ...output]
}

/**
 * Output tokens split by what bills them: per-image prices cover image tokens, media token prices
 * bill their own share, and the rest is text and reasoning. Splitting requires those counts.
 */
function rateOutputTokens(
  usage: ModelUsage,
  outputTokens: number,
  tierTokens: number,
  rateCard: TokenRateCard
): ModelCostComponent[] | Unpriceable {
  const imagesCoverTokens = rateCard.images !== undefined && (usage.outputImages ?? 0) > 0
  const missing: ModelCostMeter[] = []
  if (
    (imagesCoverTokens || rateCard.imageOutput !== undefined) &&
    usage.imageOutputTokens === undefined
  ) {
    missing.push("tokens.output.image")
  }
  if (rateCard.audioOutput !== undefined && usage.audioOutputTokens === undefined) {
    missing.push("tokens.output.audio")
  }
  if (missing.length > 0) {
    return { status: "unpriceable", reason: "missing-usage", missingMeters: missing }
  }

  const covered = imagesCoverTokens ? usage.imageOutputTokens! : 0
  const media: ModelCostComponent[] = []
  if (!imagesCoverTokens && rateCard.imageOutput !== undefined && usage.imageOutputTokens! > 0) {
    media.push(
      component("tokens.output.image", usage.imageOutputTokens!, rateCard.imageOutput, tierTokens)
    )
  }
  if (rateCard.audioOutput !== undefined && usage.audioOutputTokens! > 0) {
    media.push(
      component("tokens.output.audio", usage.audioOutputTokens!, rateCard.audioOutput, tierTokens)
    )
  }
  if (covered === 0 && media.length === 0) {
    return [component("tokens.output.total", outputTokens, rateCard.output, tierTokens)]
  }

  const remainder =
    outputTokens - covered - media.reduce((sum, entry) => sum + Number(entry.quantity), 0)
  if (remainder < 0) return { status: "unpriceable", reason: "inconsistent-usage" }
  const text = usage.textOutputTokens
  const reasoning = usage.reasoningOutputTokens
  if (remainder > 0 && text === undefined) {
    return { status: "unpriceable", reason: "missing-usage", missingMeters: ["tokens.output.text"] }
  }
  if (remainder > 0 && text! + (reasoning ?? 0) !== remainder) {
    return reasoning === undefined
      ? {
          status: "unpriceable",
          reason: "missing-usage",
          missingMeters: ["tokens.output.reasoning"],
        }
      : { status: "unpriceable", reason: "inconsistent-usage" }
  }
  return [
    ...(remainder > 0 && text! > 0
      ? [component("tokens.output.text", text!, rateCard.output, tierTokens)]
      : []),
    ...(remainder > 0 && (reasoning ?? 0) > 0
      ? [component("tokens.output.reasoning", reasoning!, rateCard.output, tierTokens)]
      : []),
    ...media,
  ]
}

type PartitionResult =
  | { readonly status: "rated"; readonly partitioned: false }
  | {
      readonly status: "rated"
      readonly partitioned: true
      readonly uncached: number
      readonly cacheRead?: number
      readonly cacheWrite?: number
      readonly cacheWrite5m?: number
      readonly cacheWrite1h?: number
    }
  | Extract<ModelCallCost, { status: "unpriceable" }>

function partitionInputUsage(usage: ModelUsage, rateCard: ModelRateCard): PartitionResult {
  const hasSpecificWrites =
    usage.cacheWrite5mInputTokens !== undefined || usage.cacheWrite1hInputTokens !== undefined
  const cacheWriteSpecific =
    (usage.cacheWrite5mInputTokens ?? 0) + (usage.cacheWrite1hInputTokens ?? 0)
  if (
    hasSpecificWrites &&
    usage.cacheWriteInputTokens !== undefined &&
    usage.cacheWriteInputTokens !== cacheWriteSpecific
  ) {
    return { status: "unpriceable", reason: "inconsistent-usage" }
  }

  const partitioned =
    usage.uncachedInputTokens !== undefined ||
    usage.cacheReadInputTokens !== undefined ||
    usage.cacheWriteInputTokens !== undefined ||
    hasSpecificWrites ||
    rateCard.cacheReadInput !== undefined ||
    rateCard.cacheWriteInput !== undefined ||
    rateCard.cacheWriteInput5m !== undefined ||
    rateCard.cacheWriteInput1h !== undefined
  if (!partitioned) return { status: "rated", partitioned: false }

  const cacheRead = usage.cacheReadInputTokens ?? 0
  const totalWrite = usage.cacheWriteInputTokens ?? cacheWriteSpecific
  if (usage.inputTokens !== undefined && cacheRead + totalWrite > usage.inputTokens) {
    return { status: "unpriceable", reason: "inconsistent-usage" }
  }

  const missing: ModelCostMeter[] = []
  if (usage.uncachedInputTokens === undefined) missing.push("tokens.input.uncached")
  if (rateCard.cacheReadInput !== undefined && usage.cacheReadInputTokens === undefined) {
    missing.push("tokens.input.cacheRead")
  }
  if (
    rateCard.cacheWriteInput !== undefined &&
    rateCard.cacheWriteInput5m === undefined &&
    rateCard.cacheWriteInput1h === undefined &&
    usage.cacheWriteInputTokens === undefined
  ) {
    missing.push("tokens.input.cacheWrite")
  }
  if (rateCard.cacheWriteInput5m !== undefined && usage.cacheWrite5mInputTokens === undefined) {
    missing.push("tokens.input.cacheWrite5m")
  }
  if (rateCard.cacheWriteInput1h !== undefined && usage.cacheWrite1hInputTokens === undefined) {
    missing.push("tokens.input.cacheWrite1h")
  }
  if (missing.length > 0) {
    return { status: "unpriceable", reason: "missing-usage", missingMeters: missing }
  }
  if (cacheRead > 0 && rateCard.cacheReadInput === undefined) {
    return {
      status: "unpriceable",
      reason: "missing-rate-card",
      missingMeters: ["tokens.input.cacheRead"],
    }
  }
  if (!hasSpecificWrites && totalWrite > 0 && rateCard.cacheWriteInput === undefined) {
    return {
      status: "unpriceable",
      reason: "missing-rate-card",
      missingMeters: ["tokens.input.cacheWrite"],
    }
  }
  if (
    (usage.cacheWrite5mInputTokens ?? 0) > 0 &&
    rateCard.cacheWriteInput5m === undefined &&
    rateCard.cacheWriteInput === undefined
  ) {
    return {
      status: "unpriceable",
      reason: "missing-rate-card",
      missingMeters: ["tokens.input.cacheWrite5m"],
    }
  }
  if (
    (usage.cacheWrite1hInputTokens ?? 0) > 0 &&
    rateCard.cacheWriteInput1h === undefined &&
    rateCard.cacheWriteInput === undefined
  ) {
    return {
      status: "unpriceable",
      reason: "missing-rate-card",
      missingMeters: ["tokens.input.cacheWrite1h"],
    }
  }

  const uncached = usage.uncachedInputTokens!
  if (uncached + cacheRead + totalWrite !== usage.inputTokens) {
    return { status: "unpriceable", reason: "inconsistent-usage" }
  }
  return {
    status: "rated",
    partitioned: true,
    uncached,
    ...(rateCard.cacheReadInput === undefined ? {} : { cacheRead }),
    ...(hasSpecificWrites
      ? {
          ...(rateCard.cacheWriteInput5m !== undefined || rateCard.cacheWriteInput !== undefined
            ? { cacheWrite5m: usage.cacheWrite5mInputTokens ?? 0 }
            : {}),
          ...(rateCard.cacheWriteInput1h !== undefined || rateCard.cacheWriteInput !== undefined
            ? { cacheWrite1h: usage.cacheWrite1hInputTokens ?? 0 }
            : {}),
        }
      : rateCard.cacheWriteInput === undefined
        ? {}
        : { cacheWrite: totalWrite }),
  }
}

function validUsageCounters(usage: ModelUsage): boolean {
  return Object.entries(usage)
    .filter(([key]) => key !== "raw")
    .every(([, value]) => value === undefined || (Number.isSafeInteger(value) && value >= 0))
}

function component(
  meter: ModelCostMeter,
  quantity: number,
  price: ModelTokenPrice,
  tierTokens: number
): ModelCostComponent {
  return componentAtRate(meter, quantity, decimalDollarsToNanos(resolvePrice(price, tierTokens)))
}

function componentAtRate(
  meter: ModelCostMeter,
  quantity: number,
  rate: bigint,
  variant?: string
): ModelCostComponent {
  const charge = (BigInt(quantity) * rate + 500_000n) / 1_000_000n
  return {
    meter,
    quantity: quantity.toString(),
    rateAmountNanosPerMillion: rate.toString(),
    chargeAmountNanos: charge.toString(),
    ...(variant ? { variant } : {}),
  }
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

function decimalDollarsToNanos(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".")
  const nanos = fraction.slice(0, 9).padEnd(9, "0")
  const roundUp = Number(fraction[9] ?? "0") >= 5
  return BigInt(whole) * 1_000_000_000n + BigInt(nanos) + (roundUp ? 1n : 0n)
}

function assertAmountNanos(value: string): void {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new TypeError("[Sixb] Provider-reported model cost must use nonnegative amountNanos.")
  }
}
