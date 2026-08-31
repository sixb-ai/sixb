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

export type ModelCostMeter =
  | "tokens.input.total"
  | "tokens.input.uncached"
  | "tokens.input.cacheRead"
  | "tokens.input.cacheWrite"
  | "tokens.input.cacheWrite5m"
  | "tokens.input.cacheWrite1h"
  | "tokens.output.total"

export interface ModelCostComponent {
  readonly meter: ModelCostMeter
  readonly quantity: string
  readonly rateAmountNanosPerMillion: string
  readonly chargeAmountNanos: string
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
      readonly reason: "missing-pricing" | "missing-usage" | "inconsistent-usage"
      readonly missingMeters?: readonly ModelCostMeter[]
    }

/** Prefer the provider's bill over catalog estimates, then rate complete token meters locally. */
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
  if (!validUsageCounters(usage)) {
    return { status: "unpriceable", reason: "inconsistent-usage" }
  }
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

  const partitioned = partitionInputUsage(usage, pricing)
  if (partitioned.status !== "rated") return partitioned

  const components: ModelCostComponent[] = []
  if (!partitioned.partitioned) {
    components.push(
      component("tokens.input.total", usage.inputTokens, pricing.input, usage.inputTokens)
    )
  } else {
    components.push(
      component("tokens.input.uncached", partitioned.uncached, pricing.input, usage.inputTokens)
    )
    if (partitioned.cacheRead !== undefined) {
      components.push(
        component(
          "tokens.input.cacheRead",
          partitioned.cacheRead,
          pricing.cacheReadInput!,
          usage.inputTokens
        )
      )
    }
    if (partitioned.cacheWrite !== undefined) {
      components.push(
        component(
          "tokens.input.cacheWrite",
          partitioned.cacheWrite,
          pricing.cacheWriteInput!,
          usage.inputTokens
        )
      )
    }
    if (partitioned.cacheWrite5m !== undefined) {
      components.push(
        component(
          "tokens.input.cacheWrite5m",
          partitioned.cacheWrite5m,
          pricing.cacheWriteInput5m ?? pricing.cacheWriteInput!,
          usage.inputTokens
        )
      )
    }
    if (partitioned.cacheWrite1h !== undefined) {
      components.push(
        component(
          "tokens.input.cacheWrite1h",
          partitioned.cacheWrite1h,
          pricing.cacheWriteInput1h ?? pricing.cacheWriteInput!,
          usage.inputTokens
        )
      )
    }
  }
  components.push(
    component("tokens.output.total", usage.outputTokens, pricing.output, usage.inputTokens)
  )
  const total = components.reduce((sum, entry) => sum + BigInt(entry.chargeAmountNanos), 0n)
  return {
    status: "rated",
    money: { currency: pricing.currency, amountNanos: total.toString() },
    components,
  }
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

function partitionInputUsage(usage: ModelUsage, pricing: LanguageModelPricing): PartitionResult {
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
    pricing.cacheReadInput !== undefined ||
    pricing.cacheWriteInput !== undefined ||
    pricing.cacheWriteInput5m !== undefined ||
    pricing.cacheWriteInput1h !== undefined
  if (!partitioned) return { status: "rated", partitioned: false }

  const cacheRead = usage.cacheReadInputTokens ?? 0
  const totalWrite = usage.cacheWriteInputTokens ?? cacheWriteSpecific
  if (usage.inputTokens !== undefined && cacheRead + totalWrite > usage.inputTokens) {
    return { status: "unpriceable", reason: "inconsistent-usage" }
  }

  const missing: ModelCostMeter[] = []
  if (usage.uncachedInputTokens === undefined) missing.push("tokens.input.uncached")
  if (pricing.cacheReadInput !== undefined && usage.cacheReadInputTokens === undefined) {
    missing.push("tokens.input.cacheRead")
  }
  if (
    pricing.cacheWriteInput !== undefined &&
    pricing.cacheWriteInput5m === undefined &&
    pricing.cacheWriteInput1h === undefined &&
    usage.cacheWriteInputTokens === undefined
  ) {
    missing.push("tokens.input.cacheWrite")
  }
  if (pricing.cacheWriteInput5m !== undefined && usage.cacheWrite5mInputTokens === undefined) {
    missing.push("tokens.input.cacheWrite5m")
  }
  if (pricing.cacheWriteInput1h !== undefined && usage.cacheWrite1hInputTokens === undefined) {
    missing.push("tokens.input.cacheWrite1h")
  }
  if (missing.length > 0) {
    return { status: "unpriceable", reason: "missing-usage", missingMeters: missing }
  }
  if (cacheRead > 0 && pricing.cacheReadInput === undefined) {
    return {
      status: "unpriceable",
      reason: "missing-pricing",
      missingMeters: ["tokens.input.cacheRead"],
    }
  }
  if (!hasSpecificWrites && totalWrite > 0 && pricing.cacheWriteInput === undefined) {
    return {
      status: "unpriceable",
      reason: "missing-pricing",
      missingMeters: ["tokens.input.cacheWrite"],
    }
  }
  if (
    (usage.cacheWrite5mInputTokens ?? 0) > 0 &&
    pricing.cacheWriteInput5m === undefined &&
    pricing.cacheWriteInput === undefined
  ) {
    return {
      status: "unpriceable",
      reason: "missing-pricing",
      missingMeters: ["tokens.input.cacheWrite5m"],
    }
  }
  if (
    (usage.cacheWrite1hInputTokens ?? 0) > 0 &&
    pricing.cacheWriteInput1h === undefined &&
    pricing.cacheWriteInput === undefined
  ) {
    return {
      status: "unpriceable",
      reason: "missing-pricing",
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
    ...(pricing.cacheReadInput === undefined ? {} : { cacheRead }),
    ...(hasSpecificWrites
      ? {
          cacheWrite5m: usage.cacheWrite5mInputTokens ?? 0,
          cacheWrite1h: usage.cacheWrite1hInputTokens ?? 0,
        }
      : pricing.cacheWriteInput === undefined
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
  const rate = decimalDollarsToNanos(resolvePrice(price, tierTokens))
  const charge = (BigInt(quantity) * rate + 500_000n) / 1_000_000n
  return {
    meter,
    quantity: quantity.toString(),
    rateAmountNanosPerMillion: rate.toString(),
    chargeAmountNanos: charge.toString(),
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
