/** Decimal USD. Strings keep provider prices exact. */
export type ModelUnitPrice = string

export interface ModelPricingTier {
  readonly minTokens: number
  readonly maxTokens?: number
  readonly price: ModelUnitPrice
}

export type ModelTokenPrice =
  | ModelUnitPrice
  | { readonly default: ModelUnitPrice; readonly tiers: readonly ModelPricingTier[] }

/** Request facts a price can depend on, such as an image's size or a voice's tier. */
export interface ModelPricingDimensions {
  readonly size?: string
  readonly quality?: string
  readonly style?: string
  readonly voiceTier?: string
}

export interface ModelPriceVariant extends ModelPricingDimensions {
  readonly price: ModelUnitPrice
}

/**
 * One price, or prices that vary with the request. Every variant names the same dimensions; a
 * request no variant matches is billed at `default`, and is unpriceable without one.
 */
export type ModelVariantPrice =
  | ModelUnitPrice
  | { readonly default?: ModelUnitPrice; readonly variants: readonly ModelPriceVariant[] }

/**
 * What one provider bills for one model. A card lists only the meters its provider charges:
 * token prices come as an input and output pair, per million tokens.
 */
export interface ModelRateCard {
  readonly currency: "USD"
  readonly input?: ModelTokenPrice
  readonly output?: ModelTokenPrice
  readonly cacheReadInput?: ModelTokenPrice
  readonly cacheWriteInput?: ModelTokenPrice
  readonly cacheWriteInput5m?: ModelTokenPrice
  readonly cacheWriteInput1h?: ModelTokenPrice
  /** Output tokens that encode images, when billed apart from other output. */
  readonly imageOutput?: ModelTokenPrice
  /** Output tokens that encode audio, when billed apart from other output. */
  readonly audioOutput?: ModelTokenPrice
  /** Per generated image. Image output tokens are then not billed as tokens. */
  readonly images?: ModelVariantPrice
  /** Per million input characters. */
  readonly characters?: ModelVariantPrice
}

const PRICING_DIMENSIONS = ["size", "quality", "style", "voiceTier"] as const

const TOKEN_DETAIL_FIELDS = [
  "cacheReadInput",
  "cacheWriteInput",
  "cacheWriteInput5m",
  "cacheWriteInput1h",
  "imageOutput",
  "audioOutput",
] as const

/** Validate and snapshot provider-owned pricing independently of operational metadata. */
export function defineModelRateCard(rateCard: ModelRateCard): ModelRateCard {
  assertRecord(rateCard, "rate card")
  if (rateCard.currency !== "USD") {
    throw new TypeError("[Sixb] Model rate cards must use USD.")
  }

  const tokens = rateCard.input !== undefined || rateCard.output !== undefined
  if (tokens && (rateCard.input === undefined || rateCard.output === undefined)) {
    throw new TypeError("[Sixb] Model rate cards must price input and output tokens together.")
  }
  if (!tokens && TOKEN_DETAIL_FIELDS.some((field) => rateCard[field] !== undefined)) {
    throw new TypeError("[Sixb] Model rate card token details require input and output prices.")
  }
  if (!tokens && rateCard.images === undefined && rateCard.characters === undefined) {
    throw new TypeError("[Sixb] Model rate cards must price tokens, images or characters.")
  }
  if (rateCard.images !== undefined && rateCard.imageOutput !== undefined) {
    throw new TypeError(
      "[Sixb] Model rate cards bill image output per image or per token, not both."
    )
  }

  return Object.freeze({
    currency: "USD",
    ...(tokens ? { input: tokenPrice(rateCard.input), output: tokenPrice(rateCard.output) } : {}),
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
    ...(rateCard.imageOutput === undefined
      ? {}
      : { imageOutput: tokenPrice(rateCard.imageOutput) }),
    ...(rateCard.audioOutput === undefined
      ? {}
      : { audioOutput: tokenPrice(rateCard.audioOutput) }),
    ...(rateCard.images === undefined ? {} : { images: variantPrice(rateCard.images, "images") }),
    ...(rateCard.characters === undefined
      ? {}
      : { characters: variantPrice(rateCard.characters, "characters") }),
  })
}

/** @internal The price for a request, and the variant that set it. */
export function resolveModelVariantPrice(
  price: ModelVariantPrice,
  dimensions: ModelPricingDimensions | undefined
): { readonly price: ModelUnitPrice; readonly variant?: string } | undefined {
  if (typeof price === "string") return { price }
  const variant = price.variants.find((candidate) =>
    PRICING_DIMENSIONS.every(
      (dimension) =>
        candidate[dimension] === undefined || candidate[dimension] === dimensions?.[dimension]
    )
  )
  if (variant) {
    const label = PRICING_DIMENSIONS.flatMap((dimension) => variant[dimension] ?? []).join(" · ")
    return { price: variant.price, variant: label }
  }
  return price.default === undefined ? undefined : { price: price.default }
}

/** @internal Every price a request could be billed at, for conservative reservations. */
export function modelVariantPrices(price: ModelVariantPrice): readonly ModelUnitPrice[] {
  if (typeof price === "string") return [price]
  return [
    ...(price.default === undefined ? [] : [price.default]),
    ...price.variants.map((variant) => variant.price),
  ]
}

function variantPrice(value: ModelVariantPrice, field: string): ModelVariantPrice {
  if (typeof value === "string") return price(value)
  assertRecord(value, `${field} price`)
  if (!Array.isArray(value.variants) || value.variants.length === 0) {
    throw new TypeError(`[Sixb] Model ${field} price variants must be a nonempty array.`)
  }

  let shape: string | undefined
  const seen = new Set<string>()
  const variants = value.variants.map((variant): ModelPriceVariant => {
    assertRecord(variant, `${field} price variant`)
    const dimensions: { -readonly [K in keyof ModelPricingDimensions]: string } = {}
    for (const dimension of PRICING_DIMENSIONS) {
      const named = variant[dimension]
      if (named === undefined) continue
      if (typeof named !== "string" || !named.trim()) {
        throw new TypeError(`[Sixb] Model ${field} price variant ${dimension} must be nonblank.`)
      }
      dimensions[dimension] = named
    }

    // One shared set of dimensions means a request matches at most one variant.
    const key = Object.keys(dimensions).join(",")
    if (!key || (shape !== undefined && key !== shape)) {
      throw new TypeError(
        `[Sixb] Model ${field} price variants must all name the same pricing dimensions.`
      )
    }
    shape = key
    const identity = JSON.stringify(Object.values(dimensions))
    if (seen.has(identity)) {
      throw new TypeError(`[Sixb] Model ${field} price variants must be distinct.`)
    }
    seen.add(identity)

    return Object.freeze({ ...dimensions, price: price(variant.price) })
  })

  return Object.freeze({
    ...(value.default === undefined ? {} : { default: price(value.default) }),
    variants: Object.freeze(variants),
  })
}

function tokenPrice(value: ModelTokenPrice | undefined): ModelTokenPrice {
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
