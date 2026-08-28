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
  AiPriceSource,
  AiPricingContext,
  AiUnpriceableReason,
} from "@sixb/core/storage"
import { normalizeAiModelCallUsage } from "@sixb/core/storage"
import catalogJson from "./models-dev-pricing.json"

const SIGNED_INT64_MAX = 9_223_372_036_854_775_807n
const TOKENS_PER_MILLION = 1_000_000n
const HALF_MILLION = TOKENS_PER_MILLION / 2n
const MAX_NUMERIC_TEXT_LENGTH = 128

interface RateAiModelCallInput {
  readonly usage: AiModelCallUsageRecord
  readonly pricingContext?: AiPricingContext
  readonly ratedAt: Date
}

interface CatalogRateSet {
  readonly input: string
  readonly output: string
  readonly cacheRead?: string
  readonly cacheWrite?: string
  readonly reasoning?: string
  readonly inputAudio?: string
  readonly outputAudio?: string
}

interface CatalogTier extends CatalogRateSet {
  readonly aboveInputTokens: string
}

interface CatalogPrice extends CatalogRateSet {
  readonly tiers?: readonly CatalogTier[]
  readonly modes?: Readonly<Record<string, Omit<CatalogPrice, "modes">>>
}

interface ModelsDevCatalog {
  readonly source: {
    readonly id: string
    readonly version: string
    readonly url: string
    readonly observedAt: string
  }
  readonly providers: Readonly<Record<string, Readonly<Record<string, CatalogPrice>>>>
}

const catalog = catalogJson as ModelsDevCatalog

/** Reviewed AI SDK namespaces whose provider key differs from Models.dev. */
const SDK_PROVIDER_BINDINGS: Readonly<Record<string, string>> = {
  "anthropic.messages": "anthropic",
  "openai.responses": "openai",
  "openai.chat": "openai",
  "google.generative-ai": "google",
  "amazon-bedrock.converse": "amazon-bedrock",
  gateway: "vercel",
  "gateway.language-model": "vercel",
  bedrock: "amazon-bedrock",
  "google.vertex": "google-vertex",
  "google.vertex.anthropic": "google-vertex",
  vertex: "google-vertex",
  "groq.chat": "groq",
  "wafer.ai.chat": "wafer.ai",
}

/** Metadata for the immutable Models.dev snapshot shipped with this agent worker. */
export const MODELS_DEV_CATALOG_SOURCE = Object.freeze({
  sourceId: catalog.source.id,
  sourceVersion: catalog.source.version,
  sourceUrl: catalog.source.url,
  observedAt: new Date(catalog.source.observedAt),
})

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

  const entry = catalog.providers[billingIdentity.providerId]?.[billingIdentity.modelId]
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
  let rates: CatalogRateSet = entry
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
  const providerId =
    SDK_PROVIDER_BINDINGS[usage.providerId] ??
    (Object.hasOwn(catalog.providers, usage.providerId) ? usage.providerId : undefined)
  if (providerId === undefined) return undefined

  // Models.dev's `vercel` catalog can key a Gateway route by either its requested name or its
  // canonical routed name. Prefer the exact requested catalog entry, then the exact canonical
  // entry. The response model identifies the underlying serving model and is not a Gateway SKU.
  if (providerId === "vercel" && isGatewayProvider(usage.providerId)) {
    const canonicalSlug = gatewayCanonicalSlug(usage.rawUsage)
    const models = catalog.providers[providerId]!
    const modelId = [usage.requestedModelId, canonicalSlug].find(
      (candidate): candidate is string =>
        candidate !== undefined && Object.hasOwn(models, candidate)
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

function componentsForUsage(usage: AiModelCallUsage, rates: CatalogRateSet): ComponentResult {
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

function selectTier(tiers: readonly CatalogTier[], inputTokens: number): CatalogTier | undefined {
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
    sourceId: catalog.source.id,
    sourceEntryId,
    sourceVersion: catalog.source.version,
    sourceUrl: catalog.source.url,
    observedAt: new Date(catalog.source.observedAt),
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
