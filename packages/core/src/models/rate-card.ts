/** Decimal USD per million tokens. Strings keep provider prices exact. */
export type ModelUnitPrice = string

export interface ModelPricingTier {
  readonly minTokens: number
  readonly maxTokens?: number
  readonly price: ModelUnitPrice
}

export type ModelTokenPrice =
  | ModelUnitPrice
  | { readonly default: ModelUnitPrice; readonly tiers: readonly ModelPricingTier[] }

export interface LanguageModelRateCard {
  readonly currency: "USD"
  readonly unit: "million-tokens"
  readonly input: ModelTokenPrice
  readonly output: ModelTokenPrice
  readonly cacheReadInput?: ModelTokenPrice
  readonly cacheWriteInput?: ModelTokenPrice
  readonly cacheWriteInput5m?: ModelTokenPrice
  readonly cacheWriteInput1h?: ModelTokenPrice
}

/** Validate and snapshot provider-owned pricing independently of operational metadata. */
export function defineModelRateCard(rateCard: LanguageModelRateCard): LanguageModelRateCard {
  assertRecord(rateCard, "rate card")
  if (rateCard.currency !== "USD" || rateCard.unit !== "million-tokens") {
    throw new TypeError("[Sixb] Model rate cards must use USD per million tokens.")
  }
  return Object.freeze({
    currency: "USD",
    unit: "million-tokens",
    input: tokenPrice(rateCard.input),
    output: tokenPrice(rateCard.output),
    ...(rateCard.cacheReadInput === undefined
      ? {}
      : { cacheReadInput: tokenPrice(rateCard.cacheReadInput) }),
    ...(rateCard.cacheWriteInput === undefined
      ? {}
      : { cacheWriteInput: tokenPrice(rateCard.cacheWriteInput) }),
    ...(rateCard.cacheWriteInput5m === undefined
      ? {}
      : { cacheWriteInput5m: tokenPrice(rateCard.cacheWriteInput5m) }),
    ...(rateCard.cacheWriteInput1h === undefined
      ? {}
      : { cacheWriteInput1h: tokenPrice(rateCard.cacheWriteInput1h) }),
  })
}

function tokenPrice(value: ModelTokenPrice): ModelTokenPrice {
  if (typeof value === "string") return price(value)
  assertRecord(value, "token price")
  if (!Array.isArray(value.tiers)) throw new TypeError("[Sixb] Model price tiers must be an array.")
  let previousMax = 0
  return Object.freeze({
    default: price(value.default),
    tiers: Object.freeze(
      value.tiers.map((tier, index) => {
        assertRecord(tier, "price tier")
        if (
          typeof tier.minTokens !== "number" ||
          !Number.isSafeInteger(tier.minTokens) ||
          tier.minTokens < 0
        ) {
          throw new TypeError("[Sixb] Model price tier has an invalid minimum.")
        }
        if (index > 0 && tier.minTokens < previousMax) {
          throw new TypeError("[Sixb] Model price tiers must be ordered and nonoverlapping.")
        }
        if (
          tier.maxTokens !== undefined &&
          (typeof tier.maxTokens !== "number" ||
            !Number.isSafeInteger(tier.maxTokens) ||
            tier.maxTokens <= tier.minTokens)
        ) {
          throw new TypeError("[Sixb] Model price tier has an invalid maximum.")
        }
        previousMax = tier.maxTokens ?? Number.POSITIVE_INFINITY
        return Object.freeze({
          minTokens: tier.minTokens,
          ...(tier.maxTokens === undefined ? {} : { maxTokens: tier.maxTokens }),
          price: price(tier.price),
        })
      })
    ),
  })
}

function price(value: unknown): string {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new TypeError("[Sixb] Model price must be a nonnegative decimal string.")
  }
  return value
}

function assertRecord(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`[Sixb] Model ${field} must be an object.`)
  }
}
