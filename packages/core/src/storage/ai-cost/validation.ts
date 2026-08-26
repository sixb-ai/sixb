import type { AiModelCallUsage, AiModelCallUsageRecord } from "../ai-usage"
import { normalizeAiModelCallUsage } from "../ai-usage"
import type {
  AiBillableMeter,
  AiBillingIdentity,
  AiCostComponent,
  AiModelCallCostRecord,
  AiPriceSource,
  AiPricingContext,
  AiRatedModelCallCostRecord,
  AiUnpriceableModelCallCostRecord,
  AiUnpriceableReason,
} from "./types"

const SIGNED_INT64_MAX = 9_223_372_036_854_775_807n
const TOKENS_PER_MILLION = 1_000_000n
const HALF_MILLION = TOKENS_PER_MILLION / 2n
const MAX_NUMERIC_TEXT_LENGTH = 128
const METER_ORDER: Readonly<Record<AiBillableMeter, number>> = {
  "tokens.input.total": 0,
  "tokens.input.uncached": 1,
  "tokens.input.cacheRead": 2,
  "tokens.input.cacheWrite": 3,
  "tokens.output.total": 4,
  "tokens.output.text": 5,
  "tokens.output.reasoning": 6,
}
const METERS = new Set(Object.keys(METER_ORDER))
const UNPRICEABLE_REASONS = new Set<AiUnpriceableReason>([
  "missingBillingIdentity",
  "missingCatalogEntry",
  "missingUsageMeter",
  "unsupportedPricingDimension",
  "invalidUsageForFormula",
])
const CONTEXT_STRING_FIELDS = [
  "serviceTier",
  "region",
  "inferenceGeo",
  "routedProviderId",
  "deploymentId",
  "inferenceProfileId",
  "mode",
] as const

export function normalizeAiPricingContext(input: AiPricingContext): AiPricingContext {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("[Sixb] AI pricing context must be an object.")
  }
  const result: Record<string, string | boolean | number> = {}
  for (const field of CONTEXT_STRING_FIELDS) {
    const value = input[field]
    if (value !== undefined) {
      assertNonBlank(value, `pricingContext.${field}`)
      result[field] = value
    }
  }
  if (input.batch !== undefined) {
    if (typeof input.batch !== "boolean") {
      throw new TypeError("[Sixb] AI pricingContext.batch must be boolean.")
    }
    result.batch = input.batch
  }
  if (input.cacheWriteTtlSeconds !== undefined) {
    if (!Number.isSafeInteger(input.cacheWriteTtlSeconds) || input.cacheWriteTtlSeconds <= 0) {
      throw new TypeError(
        "[Sixb] AI pricingContext.cacheWriteTtlSeconds must be a positive safe integer."
      )
    }
    result.cacheWriteTtlSeconds = input.cacheWriteTtlSeconds
  }
  return result
}

export function normalizeAiModelCallCostRecord(
  input: AiModelCallCostRecord
): AiModelCallCostRecord {
  assertNonBlank(input.projectId, "cost record projectId")
  assertNonBlank(input.usageRecordId, "cost record usageRecordId")
  const base = {
    projectId: input.projectId,
    usageRecordId: input.usageRecordId,
    pricingContext: normalizeAiPricingContext(input.pricingContext),
    priceSource: normalizePriceSource(input.priceSource),
    ratedAt: cloneDate(input.ratedAt, "cost record ratedAt"),
  }

  if (input.status === "rated") return normalizeRatedCost(input, base)
  if (input.status === "unpriceable") return normalizeUnpriceableCost(input, base)
  throw new TypeError("[Sixb] AI cost status is invalid.")
}

/** Verify that a normalized valuation's billed quantities describe its usage record. */
export function aiModelCallCostMatchesUsage(
  record: AiModelCallCostRecord,
  usageRecord: AiModelCallUsageRecord
): boolean {
  if (record.projectId !== usageRecord.projectId || record.usageRecordId !== usageRecord.id) {
    return false
  }
  if (record.status === "unpriceable") return true

  const usage = normalizeAiModelCallUsage(usageRecord.usage)
  const components = new Map(record.components.map((component) => [component.meter, component]))
  return (
    inputComponentsMatchUsage(components, usage) && outputComponentsMatchUsage(components, usage)
  )
}

function inputComponentsMatchUsage(
  components: ReadonlyMap<AiBillableMeter, AiCostComponent>,
  usage: AiModelCallUsage
): boolean {
  if (usage.inputTokens === undefined) return false
  const total = components.get("tokens.input.total")
  const partitions = [
    ["tokens.input.uncached", usage.uncachedInputTokens],
    ["tokens.input.cacheRead", usage.cacheReadInputTokens],
    ["tokens.input.cacheWrite", usage.cacheWriteInputTokens],
  ] as const
  const presentPartitions = partitions.filter(([meter]) => components.has(meter))

  if (total) {
    return presentPartitions.length === 0 && BigInt(total.quantity) === BigInt(usage.inputTokens)
  }
  if (presentPartitions.length === 0) return false

  let quantity = 0n
  for (const [meter, expected] of presentPartitions) {
    if (expected === undefined) return false
    const component = components.get(meter)!
    if (BigInt(component.quantity) !== BigInt(expected)) return false
    quantity += BigInt(component.quantity)
  }
  return quantity === BigInt(usage.inputTokens)
}

function outputComponentsMatchUsage(
  components: ReadonlyMap<AiBillableMeter, AiCostComponent>,
  usage: AiModelCallUsage
): boolean {
  if (usage.outputTokens === undefined) return false
  const total = components.get("tokens.output.total")
  const partitions = [
    ["tokens.output.text", usage.textOutputTokens],
    ["tokens.output.reasoning", usage.reasoningOutputTokens],
  ] as const
  const presentPartitions = partitions.filter(([meter]) => components.has(meter))

  if (total) {
    return presentPartitions.length === 0 && BigInt(total.quantity) === BigInt(usage.outputTokens)
  }
  if (presentPartitions.length === 0) return false

  let quantity = 0n
  for (const [meter, expected] of presentPartitions) {
    if (expected === undefined) return false
    const component = components.get(meter)!
    if (BigInt(component.quantity) !== BigInt(expected)) return false
    quantity += BigInt(component.quantity)
  }
  return quantity === BigInt(usage.outputTokens)
}

function normalizeRatedCost(
  input: AiRatedModelCallCostRecord,
  base: Pick<
    AiRatedModelCallCostRecord,
    "projectId" | "usageRecordId" | "pricingContext" | "priceSource" | "ratedAt"
  >
): AiRatedModelCallCostRecord {
  const billingIdentity = normalizeBillingIdentity(input.billingIdentity)
  const components = input.components.map(normalizeCostComponent).sort(compareComponents)
  if (components.length === 0) throw new TypeError("[Sixb] AI rated cost requires components.")
  if (new Set(components.map((component) => component.meter)).size !== components.length) {
    throw new TypeError("[Sixb] AI rated cost cannot contain duplicate meters.")
  }
  const amountNanos = parseNonnegativeInt64(input.money.amountNanos, "money amountNanos").toString()
  if (amountNanos !== sumComponents(components)) {
    throw new TypeError("[Sixb] AI cost total does not equal its component charges.")
  }
  return {
    ...base,
    status: "rated",
    billingIdentity,
    money: { currency: normalizeCurrency(input.money.currency), amountNanos },
    components,
  }
}

function normalizeUnpriceableCost(
  input: AiUnpriceableModelCallCostRecord,
  base: Pick<
    AiUnpriceableModelCallCostRecord,
    "projectId" | "usageRecordId" | "pricingContext" | "priceSource" | "ratedAt"
  >
): AiUnpriceableModelCallCostRecord {
  if (!UNPRICEABLE_REASONS.has(input.reason)) {
    throw new TypeError(`[Sixb] AI unpriceable reason '${String(input.reason)}' is invalid.`)
  }
  const billingIdentity = input.billingIdentity
    ? normalizeBillingIdentity(input.billingIdentity)
    : undefined
  if (input.reason === "missingBillingIdentity" && billingIdentity !== undefined) {
    throw new TypeError("[Sixb] AI missingBillingIdentity cannot contain a billing identity.")
  }
  if (input.reason !== "missingBillingIdentity" && billingIdentity === undefined) {
    throw new TypeError(`[Sixb] AI ${input.reason} requires a billing identity.`)
  }
  const missingMeters = normalizeMissingMeters(input.missingMeters)
  if (input.reason === "missingUsageMeter" && !missingMeters) {
    throw new TypeError("[Sixb] AI missingUsageMeter requires missingMeters.")
  }
  return {
    ...base,
    status: "unpriceable",
    ...(billingIdentity ? { billingIdentity } : {}),
    reason: input.reason,
    ...(missingMeters ? { missingMeters } : {}),
  }
}

function normalizeCostComponent(input: AiCostComponent): AiCostComponent {
  if (!METERS.has(input.meter)) {
    throw new TypeError(`[Sixb] AI cost meter '${String(input.meter)}' is invalid.`)
  }
  const expected = calculateComponent(input.meter, input.quantity, input.rateAmountNanosPerMillion)
  if (expected.chargeAmountNanos !== input.chargeAmountNanos) {
    throw new TypeError(`[Sixb] AI cost component '${input.meter}' charge is invalid.`)
  }
  return expected
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

function normalizePriceSource(input: AiPriceSource): AiPriceSource {
  assertNonBlank(input.sourceId, "price sourceId")
  assertNonBlank(input.sourceEntryId, "price sourceEntryId")
  assertNonBlank(input.sourceVersion, "price sourceVersion")
  assertNonBlank(input.sourceUrl, "price sourceUrl")
  return { ...input, observedAt: cloneDate(input.observedAt, "price source observedAt") }
}

function normalizeBillingIdentity(input: AiBillingIdentity): AiBillingIdentity {
  assertNonBlank(input.providerId, "billingIdentity.providerId")
  assertNonBlank(input.modelId, "billingIdentity.modelId")
  return { providerId: input.providerId, modelId: input.modelId }
}

function normalizeMissingMeters(
  input: readonly AiBillableMeter[] | undefined
): readonly AiBillableMeter[] | undefined {
  if (!input?.length) return undefined
  const result = [...new Set(input)]
  for (const meter of result) {
    if (!METERS.has(meter)) throw new TypeError(`[Sixb] AI missing meter '${meter}' is invalid.`)
  }
  return result.sort((left, right) => METER_ORDER[left] - METER_ORDER[right])
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
      throw new TypeError(`[Sixb] AI ${field} must be a non-negative safe integer.`)
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
    throw new TypeError(`[Sixb] AI ${field} must be a non-negative integer string.`)
  }
  const parsed = BigInt(value)
  assertSignedInt64(parsed, field)
  return parsed
}

function compareComponents(left: AiCostComponent, right: AiCostComponent): number {
  return METER_ORDER[left.meter] - METER_ORDER[right.meter]
}

function normalizeCurrency(value: string): string {
  if (!/^[A-Z]{3}$/.test(value)) {
    throw new TypeError("[Sixb] AI currency must be a three-letter uppercase code.")
  }
  return value
}

function assertSignedInt64(value: bigint, field: string): void {
  if (value < 0n || value > SIGNED_INT64_MAX) {
    throw new TypeError(`[Sixb] AI ${field} exceeds the signed 64-bit range.`)
  }
}

function assertNonBlank(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`[Sixb] AI ${field} must be nonblank.`)
  }
}

function cloneDate(value: Date, field: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`[Sixb] AI ${field} must be a valid Date.`)
  }
  return new Date(value)
}
