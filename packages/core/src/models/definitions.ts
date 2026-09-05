import {
  MODEL_REASONING_EFFORTS,
  type ModelCapabilities,
  type ModelReasoningBudgetCapabilities,
  type ModelReasoningCapabilities,
} from "./language-model"

export type ModelKind = "language" | "image" | "video" | "embedding"

/** Common catalog identity shared by every present and future model runtime. */
export interface ModelDefinition {
  readonly kind: ModelKind
  readonly providerId: string
  readonly modelId: string
  readonly name?: string
  readonly description?: string
  readonly family?: string
  readonly tags?: readonly string[]
  readonly releaseDate?: string
}

/** A decimal USD price per one million units. Strings keep catalog data exact and serializable. */
export type ModelUnitPrice = string

export interface ModelPricingTier {
  readonly minTokens: number
  readonly maxTokens?: number
  readonly price: ModelUnitPrice
}

export type ModelTokenPrice =
  | ModelUnitPrice
  | {
      readonly default: ModelUnitPrice
      readonly tiers: readonly ModelPricingTier[]
    }

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

/** Serializable facts about one concrete model offering from one provider. */
export interface LanguageModelDefinition extends ModelDefinition {
  readonly kind: "language"
  readonly knowledgeCutoff?: string
  readonly contextWindow?: number
  /** Maximum input tokens, distinct from a shared input/output context window. */
  readonly maxInputTokens?: number
  readonly maxOutputTokens?: number
  readonly capabilities: ModelCapabilities
  readonly rateCard?: LanguageModelRateCard
}

export function defineLanguageModel(definition: LanguageModelDefinition): LanguageModelDefinition {
  if (definition.kind !== "language") {
    throw new TypeError("[Sixb] Language model definitions must use kind 'language'.")
  }
  assertModelId(definition.providerId, "providerId")
  assertModelId(definition.modelId, "modelId")
  assertOptionalString(definition.name, "name")
  assertOptionalString(definition.description, "description")
  assertOptionalString(definition.family, "family")
  assertOptionalString(definition.releaseDate, "releaseDate")
  assertOptionalString(definition.knowledgeCutoff, "knowledgeCutoff")
  const tags = freezeStrings(definition.tags, "tags")
  const capabilities = freezeCapabilities(definition.capabilities)
  assertOptionalPositiveInteger(definition.contextWindow, "contextWindow")
  assertOptionalPositiveInteger(definition.maxInputTokens, "maxInputTokens")
  assertOptionalPositiveInteger(definition.maxOutputTokens, "maxOutputTokens")
  if (definition.rateCard) assertLanguageModelRateCard(definition.rateCard)
  return Object.freeze({
    kind: "language",
    providerId: definition.providerId,
    modelId: definition.modelId,
    ...(definition.name === undefined ? {} : { name: definition.name }),
    ...(definition.description === undefined ? {} : { description: definition.description }),
    ...(definition.family === undefined ? {} : { family: definition.family }),
    ...(tags === undefined ? {} : { tags }),
    ...(definition.releaseDate === undefined ? {} : { releaseDate: definition.releaseDate }),
    ...(definition.knowledgeCutoff === undefined
      ? {}
      : { knowledgeCutoff: definition.knowledgeCutoff }),
    ...(definition.contextWindow === undefined ? {} : { contextWindow: definition.contextWindow }),
    ...(definition.maxInputTokens === undefined
      ? {}
      : { maxInputTokens: definition.maxInputTokens }),
    ...(definition.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: definition.maxOutputTokens }),
    capabilities,
    ...(definition.rateCard === undefined ? {} : { rateCard: freezeRateCard(definition.rateCard) }),
  })
}

function freezeCapabilities(capabilities: ModelCapabilities): ModelCapabilities {
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    throw new TypeError("[Sixb] Model capabilities must be an object.")
  }
  const inputMediaTypes =
    capabilities.inputMediaTypes === "any"
      ? "any"
      : freezeStrings(capabilities.inputMediaTypes, "capabilities.inputMediaTypes")
  for (const [field, value] of Object.entries(capabilities)) {
    if (field === "inputMediaTypes" || field === "reasoning") continue
    if (value !== undefined && typeof value !== "boolean") {
      throw new TypeError(`[Sixb] Model capability '${field}' must be boolean.`)
    }
  }
  const reasoning = freezeReasoningCapabilities(capabilities.reasoning)
  return Object.freeze({
    ...(inputMediaTypes === undefined ? {} : { inputMediaTypes }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(capabilities.localTools === undefined ? {} : { localTools: capabilities.localTools }),
    ...(capabilities.parallelToolCalls === undefined
      ? {}
      : { parallelToolCalls: capabilities.parallelToolCalls }),
    ...(capabilities.nativeStructuredOutput === undefined
      ? {}
      : { nativeStructuredOutput: capabilities.nativeStructuredOutput }),
    ...(capabilities.providerExecutedTools === undefined
      ? {}
      : { providerExecutedTools: capabilities.providerExecutedTools }),
  })
}

function freezeReasoningCapabilities(
  reasoning: ModelCapabilities["reasoning"]
): ModelCapabilities["reasoning"] {
  if (reasoning === undefined || reasoning === false) return reasoning
  if (!reasoning || typeof reasoning !== "object" || Array.isArray(reasoning)) {
    throw new TypeError("[Sixb] Model capability 'reasoning' must be false or an object.")
  }
  if (reasoning.canDisable !== undefined && typeof reasoning.canDisable !== "boolean") {
    throw new TypeError("[Sixb] Model reasoning capability 'canDisable' must be boolean.")
  }
  const efforts = freezeReasoningEfforts(reasoning.efforts)
  const budgetTokens = freezeReasoningBudgetCapabilities(reasoning.budgetTokens)
  return Object.freeze({
    ...(reasoning.canDisable === undefined ? {} : { canDisable: reasoning.canDisable }),
    ...(efforts === undefined ? {} : { efforts }),
    ...(budgetTokens === undefined ? {} : { budgetTokens }),
  } satisfies ModelReasoningCapabilities)
}

function freezeReasoningEfforts(
  efforts: ModelReasoningCapabilities["efforts"]
): readonly (typeof MODEL_REASONING_EFFORTS)[number][] | undefined {
  if (efforts === undefined) return undefined
  if (!Array.isArray(efforts)) {
    throw new TypeError("[Sixb] Model reasoning capability 'efforts' must be an array.")
  }
  const allowed = MODEL_REASONING_EFFORTS as readonly string[]
  const seen = new Set<string>()
  for (const effort of efforts) {
    if (!allowed.includes(effort)) {
      throw new TypeError(`[Sixb] Model reasoning effort '${String(effort)}' is invalid.`)
    }
    if (seen.has(effort)) {
      throw new TypeError(`[Sixb] Model reasoning effort '${effort}' is duplicated.`)
    }
    seen.add(effort)
  }
  return Object.freeze([...efforts])
}

function freezeReasoningBudgetCapabilities(
  budget: ModelReasoningCapabilities["budgetTokens"]
): ModelReasoningBudgetCapabilities | undefined {
  if (budget === undefined) return undefined
  if (!budget || typeof budget !== "object" || Array.isArray(budget)) {
    throw new TypeError("[Sixb] Model reasoning capability 'budgetTokens' must be an object.")
  }
  assertOptionalNonnegativeInteger(budget.min, "capabilities.reasoning.budgetTokens.min")
  assertOptionalNonnegativeInteger(budget.max, "capabilities.reasoning.budgetTokens.max")
  if (budget.min !== undefined && budget.max !== undefined && budget.max < budget.min) {
    throw new TypeError(
      "[Sixb] Model reasoning token budget maximum must not be below its minimum."
    )
  }
  return Object.freeze({
    ...(budget.min === undefined ? {} : { min: budget.min }),
    ...(budget.max === undefined ? {} : { max: budget.max }),
  })
}

function freezeRateCard(rateCard: LanguageModelRateCard): LanguageModelRateCard {
  return Object.freeze({
    currency: "USD",
    unit: "million-tokens",
    input: freezeTokenPrice(rateCard.input),
    output: freezeTokenPrice(rateCard.output),
    ...(rateCard.cacheReadInput === undefined
      ? {}
      : { cacheReadInput: freezeTokenPrice(rateCard.cacheReadInput) }),
    ...(rateCard.cacheWriteInput === undefined
      ? {}
      : { cacheWriteInput: freezeTokenPrice(rateCard.cacheWriteInput) }),
    ...(rateCard.cacheWriteInput5m === undefined
      ? {}
      : { cacheWriteInput5m: freezeTokenPrice(rateCard.cacheWriteInput5m) }),
    ...(rateCard.cacheWriteInput1h === undefined
      ? {}
      : { cacheWriteInput1h: freezeTokenPrice(rateCard.cacheWriteInput1h) }),
  })
}

function freezeTokenPrice(price: ModelTokenPrice): ModelTokenPrice {
  return typeof price === "string"
    ? price
    : Object.freeze({
        default: price.default,
        tiers: Object.freeze(
          price.tiers.map((tier) =>
            Object.freeze({
              minTokens: tier.minTokens,
              ...(tier.maxTokens === undefined ? {} : { maxTokens: tier.maxTokens }),
              price: tier.price,
            })
          )
        ),
      })
}

function assertLanguageModelRateCard(rateCard: LanguageModelRateCard): void {
  if (rateCard.currency !== "USD" || rateCard.unit !== "million-tokens") {
    throw new TypeError("[Sixb] Model rate cards must use USD per million tokens.")
  }
  for (const [meter, value] of Object.entries(rateCard)) {
    if (meter === "currency" || meter === "unit") continue
    if (typeof value === "string") {
      assertPrice(value, meter)
      continue
    }
    assertPrice(value.default, `${meter}.default`)
    let previousMax = 0
    for (const [index, tier] of value.tiers.entries()) {
      if (!Number.isSafeInteger(tier.minTokens) || tier.minTokens < 0) {
        throw new TypeError(`[Sixb] Model price '${meter}' tier ${index} has an invalid minimum.`)
      }
      if (index > 0 && tier.minTokens < previousMax) {
        throw new TypeError(
          `[Sixb] Model price '${meter}' tiers must be ordered and nonoverlapping.`
        )
      }
      if (
        tier.maxTokens !== undefined &&
        (!Number.isSafeInteger(tier.maxTokens) || tier.maxTokens <= tier.minTokens)
      ) {
        throw new TypeError(`[Sixb] Model price '${meter}' tier ${index} has an invalid maximum.`)
      }
      previousMax = tier.maxTokens ?? Number.POSITIVE_INFINITY
      assertPrice(tier.price, `${meter}.tiers[${index}].price`)
    }
  }
}

function assertPrice(value: string, meter: string): void {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new TypeError(`[Sixb] Model price '${meter}' must be a nonnegative decimal string.`)
  }
}

function assertModelId(value: string, field: string): void {
  if (!value.trim()) throw new TypeError(`[Sixb] Model ${field} must not be empty.`)
}

function assertOptionalPositiveInteger(value: number | undefined, field: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new TypeError(`[Sixb] Model ${field} must be a positive safe integer.`)
  }
}

function assertOptionalNonnegativeInteger(value: number | undefined, field: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError(`[Sixb] Model ${field} must be a nonnegative safe integer.`)
  }
}

function assertOptionalString(value: string | undefined, field: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new TypeError(`[Sixb] Model ${field} must be a string.`)
  }
}

function freezeStrings(
  value: readonly string[] | undefined,
  field: string
): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new TypeError(`[Sixb] Model ${field} must contain nonempty strings.`)
  }
  return Object.freeze([...value])
}
