import type {
  AiModelCallUsageRecord,
  AiPricingContext,
  AiReportedModelCallCostRecord,
} from "@sixb/core/storage"

const SIGNED_INT64_MAX = 9_223_372_036_854_775_807n

/** Normalize only understood provider reports, never arbitrary metadata named "cost". */
export function providerReportedCost(input: {
  readonly usage: AiModelCallUsageRecord
  readonly pricingContext: AiPricingContext
  readonly ratedAt: Date
}): AiReportedModelCallCostRecord | undefined {
  const { usage } = input
  if (usage.providerId !== "gateway") return undefined
  const metadata = usage.rawUsage?.providerMetadata
  if (!isRecord(metadata) || !isRecord(metadata.gateway)) return undefined
  const gateway = metadata.gateway
  const responseId = gateway.generationId
  if (typeof responseId !== "string" || responseId.trim().length === 0) return undefined

  // Gateway cost is not a complete BYOK bill. Accept only confirmed system-credential
  // routes; missing/unknown routing metadata falls back to the catalog.
  // https://vercel.com/docs/ai-gateway/authentication-and-byok/byok
  if (!usesOnlySystemCredentials(gateway.routing)) return undefined
  const amountNanos = usdToNanos(gateway.cost)
  if (amountNanos === undefined) return undefined

  return {
    projectId: usage.projectId,
    usageRecordId: usage.id,
    status: "reported",
    billingIdentity: { providerId: usage.providerId, modelId: usage.requestedModelId },
    pricingContext: input.pricingContext,
    reportSource: { providerId: usage.providerId, responseId },
    money: { currency: "USD", amountNanos },
    ratedAt: input.ratedAt,
  }
}

function usesOnlySystemCredentials(routing: unknown): boolean {
  if (
    !isRecord(routing) ||
    !Array.isArray(routing.modelAttempts) ||
    routing.modelAttempts.length === 0
  )
    return false
  return routing.modelAttempts.every(
    (model: unknown) =>
      isRecord(model) &&
      Array.isArray(model.providerAttempts) &&
      model.providerAttempts.length > 0 &&
      model.providerAttempts.every(
        (attempt: unknown) => isRecord(attempt) && attempt.credentialType === "system"
      )
  )
}

/** Round decimal USD half-up to nanos, without floating-point multiplication. */
function usdToNanos(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined
  const text = String(value)
  if (text.length > 128) return undefined
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d{1,3}))?$/.exec(text)
  if (!match) return undefined
  const fraction = match[2] ?? ""
  const coefficient = BigInt(match[1]! + fraction)
  const shift = 9 + Number(match[3] ?? 0) - fraction.length
  let nanos: bigint
  if (shift >= 0) {
    nanos = coefficient * 10n ** BigInt(shift)
  } else {
    const divisor = 10n ** BigInt(-shift)
    nanos = (coefficient + divisor / 2n) / divisor
  }
  return nanos <= SIGNED_INT64_MAX ? nanos.toString() : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
