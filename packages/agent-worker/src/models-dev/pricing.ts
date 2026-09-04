import {
  normalizeAiModelCallCostRecord,
  normalizeAiPricingContext,
} from "@sixb/core/internal/ai-cost-storage-provider"
import type {
  AiBillableMeter,
  AiBillingIdentity,
  AiCostComponent,
  AiModelCallCostRecord,
  AiModelCallUsage,
  AiModelCallUsageRecord,
  AiMoney,
  AiPriceSource,
  AiPricingContext,
  AiUnpriceableReason,
} from "@sixb/core/storage"
import { normalizeAiModelCallUsage } from "@sixb/core/storage"
import {
  getModelsDevCatalogModel,
  getModelsDevProviderModels,
  MODELS_DEV_CATALOG_SOURCE,
  type ModelsDevCatalogRateSet,
  type ModelsDevCatalogTier,
  resolveModelsDevProviderId,
} from "./catalog"

export { MODELS_DEV_CATALOG_SOURCE } from "./catalog"

const SIGNED_INT64_MAX = 9_223_372_036_854_775_807n
const TOKENS_PER_MILLION = 1_000_000n
const HALF_MILLION = TOKENS_PER_MILLION / 2n
const MAX_NUMERIC_TEXT_LENGTH = 128

interface RateAiModelCallInput {
  readonly usage: AiModelCallUsageRecord
  readonly pricingContext?: AiPricingContext
  readonly ratedAt: Date
}

export interface EstimateAiModelCallCostInput {
  readonly providerId: string
  readonly modelId: string
  readonly pricingContext?: AiPricingContext
  readonly inputTokens: number
  readonly outputTokens: number
}

export type AiModelCallCostEstimate =
  | {
      readonly status: "estimated"
      readonly money: AiMoney & { readonly currency: "USD" }
      readonly billingIdentity: AiBillingIdentity
    }
  | {
      readonly status: "unavailable"
      readonly reason: AiUnpriceableReason
      readonly billingIdentity?: AiBillingIdentity
    }

/**
 * Conservatively pre-price one prepared text request against the pinned catalog.
 *
 * Each token partition is charged at the highest applicable rate, with an extra rounding bound for
 * every possible partition. The reservation can therefore be larger than the final valuation but
 * cannot be smaller merely because cache or reasoning partitions are not known before the call.
 */
export function estimateAiModelCallCost(
  input: EstimateAiModelCallCostInput
): AiModelCallCostEstimate {
  const pricingContext = normalizeAiPricingContext(input.pricingContext ?? {})
  const inputTokens = parseQuantity(input.inputTokens, "estimated input token quantity")
  const outputTokens = parseQuantity(input.outputTokens, "estimated output token quantity")
  const billingIdentity = resolveModelsDevBillingIdentity({
    providerId: input.providerId,
    requestedModelId: input.modelId,
  })
  if (!billingIdentity) return { status: "unavailable", reason: "missingBillingIdentity" }

  const entry = getModelsDevCatalogModel(
    billingIdentity.providerId,
    billingIdentity.modelId
  )?.pricing
  if (!entry) {
    return { status: "unavailable", reason: "missingCatalogEntry", billingIdentity }
  }
  if (
    pricingContext.batch === true ||
    !isBaseServiceTier(pricingContext.serviceTier) ||
    (pricingContext.cacheWriteTtlSeconds !== undefined &&
      pricingContext.cacheWriteTtlSeconds !== 300) ||
    hasUnsupportedRoutingContext(pricingContext)
  ) {
    return { status: "unavailable", reason: "unsupportedPricingDimension", billingIdentity }
  }

  let rates: ModelsDevCatalogRateSet = entry
  let tiers = entry.tiers
  if (pricingContext.mode !== undefined) {
    const modeRates = entry.modes?.[pricingContext.mode]
    if (!modeRates) {
      return { status: "unavailable", reason: "unsupportedPricingDimension", billingIdentity }
    }
    rates = modeRates
    tiers = modeRates.tiers
  }
  if (tiers?.length) rates = selectTier(tiers, input.inputTokens) ?? rates

  // The snapshot only contains the five-minute cache-write rate. A request that may write cache
  // without an explicit TTL could use a differently priced provider dimension, so it is unsafe to
  // admit under a hard catalog-cost policy.
  if (rates.cacheWrite !== undefined && pricingContext.cacheWriteTtlSeconds === undefined) {
    return { status: "unavailable", reason: "unsupportedPricingDimension", billingIdentity }
  }

  const inputRates = [rates.input, rates.cacheRead, rates.cacheWrite].filter(
    (rate): rate is string => rate !== undefined
  )
  const outputRates = [rates.output, rates.reasoning].filter(
    (rate): rate is string => rate !== undefined
  )
  const inputCharge = conservativePartitionedCharge(inputTokens, inputRates, "input estimate")
  const outputCharge = conservativePartitionedCharge(outputTokens, outputRates, "output estimate")
  const amountNanos = inputCharge + outputCharge
  assertSignedInt64(amountNanos, "cost estimate")
  return {
    status: "estimated",
    money: { currency: "USD", amountNanos: amountNanos.toString() },
    billingIdentity,
  }
}

/** Rate one immutable usage record against this worker's pinned Models.dev snapshot. */
export function rateAiModelCall(input: RateAiModelCallInput): AiModelCallCostRecord {
  const usageRecord = input.usage
  assertNonBlank(usageRecord.id, "usage record id")
  assertNonBlank(usageRecord.projectId, "usage projectId")
  const ratedAt = cloneDate(input.ratedAt, "record ratedAt")
  const pricingContext = normalizeAiPricingContext(input.pricingContext ?? {})
  const source = priceSource("unresolved")
  const billingIdentity = resolveModelsDevBillingIdentity(usageRecord)

  if (!billingIdentity) {
    return unpriceable(input, ratedAt, pricingContext, source, "missingBillingIdentity")
  }

  const entry = getModelsDevCatalogModel(
    billingIdentity.providerId,
    billingIdentity.modelId
  )?.pricing
  let resolvedSource = priceSource(`${billingIdentity.providerId}/${billingIdentity.modelId}`)
  if (!entry) {
    return unpriceable(
      input,
      ratedAt,
      pricingContext,
      resolvedSource,
      "missingCatalogEntry",
      billingIdentity
    )
  }

  if (
    pricingContext.batch === true ||
    !isBaseServiceTier(pricingContext.serviceTier) ||
    (pricingContext.cacheWriteTtlSeconds !== undefined &&
      pricingContext.cacheWriteTtlSeconds !== 300) ||
    hasUnsupportedRoutingContext(pricingContext)
  ) {
    return unpriceable(
      input,
      ratedAt,
      pricingContext,
      resolvedSource,
      "unsupportedPricingDimension",
      billingIdentity
    )
  }

  const mode = pricingContext.mode
  let rates: ModelsDevCatalogRateSet = entry
  let tiers = entry.tiers
  if (mode !== undefined) {
    const modeRates = entry.modes?.[mode]
    if (!modeRates) {
      return unpriceable(
        input,
        ratedAt,
        pricingContext,
        resolvedSource,
        "unsupportedPricingDimension",
        billingIdentity
      )
    }
    rates = modeRates
    tiers = modeRates.tiers
    resolvedSource = priceSource(
      `${billingIdentity.providerId}/${billingIdentity.modelId}#mode=${mode}`
    )
  }

  const usage = normalizeAiModelCallUsage(usageRecord.usage)
  if (tiers?.length) {
    if (usage.inputTokens === undefined) {
      return unpriceable(
        input,
        ratedAt,
        pricingContext,
        resolvedSource,
        "missingUsageMeter",
        billingIdentity,
        ["tokens.input.total"]
      )
    }
    rates = selectTier(tiers, usage.inputTokens) ?? rates
  }

  // The compact catalog's cache-write rate is the five-minute price. A nonzero write without an
  // observed TTL is ambiguous because providers may also charge a different one-hour rate.
  if (
    rates.cacheWrite !== undefined &&
    usage.cacheWriteInputTokens !== undefined &&
    usage.cacheWriteInputTokens > 0 &&
    pricingContext.cacheWriteTtlSeconds === undefined
  ) {
    return unpriceable(
      input,
      ratedAt,
      pricingContext,
      resolvedSource,
      "unsupportedPricingDimension",
      billingIdentity
    )
  }

  if (
    (rates.inputAudio !== undefined || rates.outputAudio !== undefined) &&
    rawUsageContainsAudioTokens(usageRecord)
  ) {
    return unpriceable(
      input,
      ratedAt,
      pricingContext,
      resolvedSource,
      "unsupportedPricingDimension",
      billingIdentity
    )
  }

  const components = componentsForUsage(usage, rates)
  if (components.status === "unpriceable") {
    return unpriceable(
      input,
      ratedAt,
      pricingContext,
      resolvedSource,
      components.reason,
      billingIdentity,
      components.missingMeters
    )
  }

  return normalizeAiModelCallCostRecord({
    projectId: usageRecord.projectId,
    usageRecordId: usageRecord.id,
    status: "rated",
    billingIdentity,
    pricingContext,
    priceSource: resolvedSource,
    money: { currency: "USD", amountNanos: sumComponents(components.components) },
    components: components.components,
    ratedAt,
  })
}

/** Resolve only exact catalog identities or reviewed AI SDK namespace bindings. */
export function resolveModelsDevBillingIdentity(
  usage: Pick<
    AiModelCallUsageRecord,
    "providerId" | "requestedModelId" | "responseModelId" | "rawUsage"
  >
): AiBillingIdentity | undefined {
  const providerId = resolveModelsDevProviderId(usage.providerId)
  if (providerId === undefined) return undefined

  // Models.dev's `vercel` catalog can key a Gateway route by either its requested name or its
  // canonical routed name. Prefer the exact requested catalog entry, then the exact canonical
  // entry. The response model identifies the underlying serving model and is not a Gateway SKU.
  if (providerId === "vercel" && isGatewayProvider(usage.providerId)) {
    const canonicalSlug = gatewayCanonicalSlug(usage.rawUsage)
    const models = getModelsDevProviderModels(providerId)!
    const modelId = [usage.requestedModelId, canonicalSlug].find(
      (candidate): candidate is string =>
        candidate !== undefined && models[candidate]?.pricing !== undefined
    )
    return { providerId, modelId: modelId ?? usage.requestedModelId }
  }

  // A response model identifies the serving SKU when a direct provider reports one. Preserve it
  // even when this catalog does not know it so valuation fails closed instead of silently applying
  // the requested model's price to a different model.
  const modelId = usage.responseModelId ?? usage.requestedModelId
  return { providerId, modelId }
}

type ComponentResult =
  | { readonly status: "rated"; readonly components: readonly AiCostComponent[] }
  | {
      readonly status: "unpriceable"
      readonly reason: Extract<AiUnpriceableReason, "missingUsageMeter" | "invalidUsageForFormula">
      readonly missingMeters?: readonly AiBillableMeter[]
    }

function componentsForUsage(
  usage: AiModelCallUsage,
  rates: ModelsDevCatalogRateSet
): ComponentResult {
  const components: AiCostComponent[] = []
  const missing: AiBillableMeter[] = []

  if (usage.inputTokens === undefined) missing.push("tokens.input.total")
  if (usage.outputTokens === undefined) missing.push("tokens.output.total")

  const usesCachePartition = rates.cacheRead !== undefined || rates.cacheWrite !== undefined
  if (usesCachePartition) {
    if (usage.uncachedInputTokens === undefined) missing.push("tokens.input.uncached")
    if (rates.cacheRead !== undefined && usage.cacheReadInputTokens === undefined) {
      missing.push("tokens.input.cacheRead")
    }
    if (rates.cacheWrite !== undefined && usage.cacheWriteInputTokens === undefined) {
      missing.push("tokens.input.cacheWrite")
    }
  }

  if (rates.reasoning !== undefined) {
    if (usage.textOutputTokens === undefined) missing.push("tokens.output.text")
    if (usage.reasoningOutputTokens === undefined) missing.push("tokens.output.reasoning")
  }
  if (missing.length > 0) {
    return { status: "unpriceable", reason: "missingUsageMeter", missingMeters: missing }
  }

  if (usesCachePartition) {
    const uncached = usage.uncachedInputTokens!
    const cacheRead = usage.cacheReadInputTokens ?? 0
    const cacheWrite = usage.cacheWriteInputTokens ?? 0
    if (BigInt(uncached) + BigInt(cacheRead) + BigInt(cacheWrite) !== BigInt(usage.inputTokens!)) {
      return { status: "unpriceable", reason: "invalidUsageForFormula" }
    }
    if (rates.cacheRead === undefined && cacheRead !== 0) {
      return { status: "unpriceable", reason: "invalidUsageForFormula" }
    }
    if (rates.cacheWrite === undefined && cacheWrite !== 0) {
      return { status: "unpriceable", reason: "invalidUsageForFormula" }
    }
    components.push(calculateComponent("tokens.input.uncached", uncached, rates.input))
    if (rates.cacheRead !== undefined) {
      components.push(calculateComponent("tokens.input.cacheRead", cacheRead, rates.cacheRead))
    }
    if (rates.cacheWrite !== undefined) {
      components.push(calculateComponent("tokens.input.cacheWrite", cacheWrite, rates.cacheWrite))
    }
  } else {
    components.push(calculateComponent("tokens.input.total", usage.inputTokens!, rates.input))
  }

  if (rates.reasoning !== undefined) {
    const text = usage.textOutputTokens!
    const reasoning = usage.reasoningOutputTokens!
    if (BigInt(text) + BigInt(reasoning) !== BigInt(usage.outputTokens!)) {
      return { status: "unpriceable", reason: "invalidUsageForFormula" }
    }
    components.push(calculateComponent("tokens.output.text", text, rates.output))
    components.push(calculateComponent("tokens.output.reasoning", reasoning, rates.reasoning))
  } else {
    components.push(calculateComponent("tokens.output.total", usage.outputTokens!, rates.output))
  }

  return { status: "rated", components }
}

function selectTier(
  tiers: readonly ModelsDevCatalogTier[],
  inputTokens: number
): ModelsDevCatalogTier | undefined {
  return [...tiers]
    .sort((left, right) =>
      BigInt(right.aboveInputTokens) > BigInt(left.aboveInputTokens) ? 1 : -1
    )
    .find((tier) => BigInt(inputTokens) > BigInt(tier.aboveInputTokens))
}

function calculateComponent(
  meter: AiBillableMeter,
  quantity: number | string,
  rateAmountNanosPerMillion: string
): AiCostComponent {
  const normalizedQuantity = parseQuantity(quantity, `${meter} quantity`)
  const rate = parseNonnegativeInt64(rateAmountNanosPerMillion, `${meter} rate`)
  const charge = (normalizedQuantity * rate + HALF_MILLION) / TOKENS_PER_MILLION
  assertSignedInt64(charge, `${meter} charge`)
  return {
    meter,
    quantity: normalizedQuantity.toString(),
    rateAmountNanosPerMillion: rate.toString(),
    chargeAmountNanos: charge.toString(),
  }
}

function conservativePartitionedCharge(
  quantity: bigint,
  rateTexts: readonly string[],
  field: string
): bigint {
  const rates = rateTexts.map((rate) => parseNonnegativeInt64(rate, `${field} rate`))
  const maxRate = rates.reduce((maximum, rate) => (rate > maximum ? rate : maximum), 0n)
  // ceil(total * maxRate) plus one nanounit for every additional independently rounded partition.
  const charge =
    (quantity * maxRate + TOKENS_PER_MILLION - 1n) / TOKENS_PER_MILLION +
    BigInt(Math.max(0, rates.length - 1))
  assertSignedInt64(charge, `${field} charge`)
  return charge
}

function unpriceable(
  input: RateAiModelCallInput,
  ratedAt: Date,
  pricingContext: AiPricingContext,
  source: AiPriceSource,
  reason: AiUnpriceableReason,
  billingIdentity?: AiBillingIdentity,
  missingMeters?: readonly AiBillableMeter[]
): AiModelCallCostRecord {
  return normalizeAiModelCallCostRecord({
    projectId: input.usage.projectId,
    usageRecordId: input.usage.id,
    status: "unpriceable",
    ...(billingIdentity ? { billingIdentity } : {}),
    pricingContext,
    priceSource: source,
    reason,
    ...(missingMeters ? { missingMeters } : {}),
    ratedAt,
  })
}

function priceSource(sourceEntryId: string): AiPriceSource {
  return {
    sourceId: MODELS_DEV_CATALOG_SOURCE.sourceId,
    sourceEntryId,
    sourceVersion: MODELS_DEV_CATALOG_SOURCE.sourceVersion,
    sourceUrl: MODELS_DEV_CATALOG_SOURCE.sourceUrl,
    observedAt: new Date(MODELS_DEV_CATALOG_SOURCE.observedAt),
  }
}

function sumComponents(components: readonly AiCostComponent[]): string {
  let total = 0n
  for (const component of components) {
    total += parseNonnegativeInt64(component.chargeAmountNanos, "component charge")
    assertSignedInt64(total, "cost total")
  }
  return total.toString()
}

function parseQuantity(value: number | string, field: string): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`[SixbAgentWorker] AI ${field} must be a non-negative safe integer.`)
    }
    return BigInt(value)
  }
  return parseNonnegativeInt64(value, field)
}

function parseNonnegativeInt64(value: string, field: string): bigint {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_NUMERIC_TEXT_LENGTH ||
    !/^\d+$/.test(value)
  ) {
    throw new TypeError(`[SixbAgentWorker] AI ${field} must be a non-negative integer string.`)
  }
  const parsed = BigInt(value)
  assertSignedInt64(parsed, field)
  return parsed
}

function isGatewayProvider(providerId: string): boolean {
  return providerId === "gateway" || providerId === "gateway.language-model"
}

function gatewayCanonicalSlug(rawUsage: AiModelCallUsageRecord["rawUsage"]): string | undefined {
  const providerMetadata = jsonObjectProperty(rawUsage, "providerMetadata")
  const gateway = jsonObjectProperty(providerMetadata, "gateway")
  const routing = jsonObjectProperty(gateway, "routing")
  const canonicalSlug = routing?.canonicalSlug
  return typeof canonicalSlug === "string" && canonicalSlug.trim().length > 0
    ? canonicalSlug
    : undefined
}

function jsonObjectProperty(value: unknown, property: string): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const child = (value as Record<string, unknown>)[property]
  return typeof child === "object" && child !== null && !Array.isArray(child)
    ? (child as Record<string, unknown>)
    : undefined
}

function rawUsageContainsAudioTokens(usage: AiModelCallUsageRecord): boolean {
  if (!usage.rawUsage) return false
  const stack: unknown[] = [usage.rawUsage]
  while (stack.length > 0) {
    const value = stack.pop()
    if (!value || typeof value !== "object") continue
    for (const [key, child] of Object.entries(value)) {
      if (/audio.*tokens|tokens.*audio/i.test(key) && typeof child === "number" && child > 0) {
        return true
      }
      if (typeof child === "object") stack.push(child)
    }
  }
  return false
}

function isBaseServiceTier(value: string | undefined): boolean {
  return value === undefined || value === "standard" || value === "default" || value === "auto"
}

function hasUnsupportedRoutingContext(context: AiPricingContext): boolean {
  return (
    context.region !== undefined ||
    (context.inferenceGeo !== undefined && context.inferenceGeo !== "global") ||
    context.routedProviderId !== undefined ||
    context.deploymentId !== undefined ||
    context.inferenceProfileId !== undefined
  )
}

function assertSignedInt64(value: bigint, field: string): void {
  if (value < 0n || value > SIGNED_INT64_MAX) {
    throw new TypeError(`[SixbAgentWorker] AI ${field} exceeds the signed 64-bit range.`)
  }
}

function assertNonBlank(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`[SixbAgentWorker] AI ${field} must be nonblank.`)
  }
}

function cloneDate(value: Date, field: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`[SixbAgentWorker] AI ${field} must be a valid Date.`)
  }
  return new Date(value)
}
