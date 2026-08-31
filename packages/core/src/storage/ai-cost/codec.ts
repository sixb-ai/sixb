import type {
  AiBillableMeter,
  AiModelCallCostRecord,
  AiPriceSource,
  AiPricingContext,
} from "./types"
import { normalizeAiPricingContext } from "./validation"

export interface AiModelCallCostDetails {
  readonly pricingContext: AiPricingContext
  readonly priceSource?: Omit<AiPriceSource, "observedAt"> & {
    readonly observedAt: string
  }
  readonly components?: Extract<AiModelCallCostRecord, { status: "rated" }>["components"]
  readonly missingMeters?: readonly AiBillableMeter[]
}

export function aiModelCallCostDetails(record: AiModelCallCostRecord): AiModelCallCostDetails {
  return {
    pricingContext: record.pricingContext,
    ...(record.priceSource === undefined
      ? {}
      : {
          priceSource: {
            ...record.priceSource,
            observedAt: record.priceSource.observedAt.toISOString(),
          },
        }),
    ...(record.status === "rated" ? { components: record.components } : {}),
    ...(record.status === "unpriceable" && record.missingMeters
      ? { missingMeters: record.missingMeters }
      : {}),
  }
}

export function parseAiModelCallCostDetails(value: unknown): AiModelCallCostDetails {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value
  if (!isRecord(parsed)) throw invalidDetails()
  const priceSource = parsed.priceSource
  if (priceSource !== undefined && !isRecord(priceSource)) throw invalidDetails()
  const components = parsed.components
  const missingMeters = parsed.missingMeters
  return {
    pricingContext: pricingContextFromUnknown(parsed.pricingContext),
    ...(priceSource === undefined
      ? {}
      : {
          priceSource: {
            sourceId: requiredString(priceSource.sourceId),
            sourceEntryId: requiredString(priceSource.sourceEntryId),
            sourceVersion: requiredString(priceSource.sourceVersion),
            ...optionalStringProperty(priceSource, "sourceUrl"),
            observedAt: requiredString(priceSource.observedAt),
          },
        }),
    ...(components === undefined ? {} : { components: costComponentsFromUnknown(components) }),
    ...(missingMeters === undefined ? {} : { missingMeters: metersFromUnknown(missingMeters) }),
  }
}

function pricingContextFromUnknown(value: unknown): AiPricingContext {
  if (!isRecord(value)) throw invalidDetails()
  return normalizeAiPricingContext({
    ...optionalStringProperty(value, "serviceTier"),
    ...optionalBooleanProperty(value, "batch"),
    ...optionalStringProperty(value, "region"),
    ...optionalStringProperty(value, "inferenceGeo"),
    ...optionalStringProperty(value, "routedProviderId"),
    ...optionalStringProperty(value, "routedModelId"),
    ...optionalStringProperty(value, "deploymentId"),
    ...optionalStringProperty(value, "inferenceProfileId"),
    ...optionalNumberProperty(value, "cacheWriteTtlSeconds"),
    ...optionalStringProperty(value, "mode"),
  })
}

function costComponentsFromUnknown(
  value: unknown
): Extract<AiModelCallCostRecord, { status: "rated" }>["components"] {
  if (!Array.isArray(value)) throw invalidDetails()
  return value.map((component) => {
    if (!isRecord(component)) throw invalidDetails()
    return {
      meter: billableMeter(component.meter),
      quantity: requiredString(component.quantity),
      rateAmountNanosPerMillion: requiredString(component.rateAmountNanosPerMillion),
      chargeAmountNanos: requiredString(component.chargeAmountNanos),
    }
  })
}

function metersFromUnknown(value: unknown): readonly AiBillableMeter[] {
  if (!Array.isArray(value)) throw invalidDetails()
  return value.map(billableMeter)
}

function billableMeter(value: unknown): AiBillableMeter {
  if (
    value !== "tokens.input.total" &&
    value !== "tokens.input.uncached" &&
    value !== "tokens.input.cacheRead" &&
    value !== "tokens.input.cacheWrite" &&
    value !== "tokens.input.cacheWrite5m" &&
    value !== "tokens.input.cacheWrite1h" &&
    value !== "tokens.output.total" &&
    value !== "tokens.output.text" &&
    value !== "tokens.output.reasoning"
  ) {
    throw invalidDetails()
  }
  return value
}

function optionalStringProperty(
  value: Record<string, unknown>,
  name: string
): Record<string, string> {
  const property = value[name]
  if (property === undefined) return {}
  if (typeof property !== "string") throw invalidDetails()
  return { [name]: property }
}

function optionalBooleanProperty(
  value: Record<string, unknown>,
  name: string
): Record<string, boolean> {
  const property = value[name]
  if (property === undefined) return {}
  if (typeof property !== "boolean") throw invalidDetails()
  return { [name]: property }
}

function optionalNumberProperty(
  value: Record<string, unknown>,
  name: string
): Record<string, number> {
  const property = value[name]
  if (property === undefined) return {}
  if (typeof property !== "number") throw invalidDetails()
  return { [name]: property }
}

function requiredString(value: unknown): string {
  if (typeof value !== "string") throw invalidDetails()
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function invalidDetails(): Error {
  return new Error("[Sixb] AI valuation details are invalid.")
}
