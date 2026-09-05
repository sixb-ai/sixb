import type { LanguageModelRateCard, ModelTokenPrice } from "./definitions"
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
      readonly reason: "missing-rate-card" | "missing-usage" | "inconsistent-usage"
      readonly missingMeters?: readonly ModelCostMeter[]
    }

/** Prefer the provider's bill over rate-card estimates, then rate complete token meters locally. */
export function rateModelCall(input: {
  readonly usage: ModelUsage
  readonly rateCard?: LanguageModelRateCard
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
  components.push(
    component("tokens.output.total", usage.outputTokens, rateCard.output, usage.inputTokens)
  )
  const total = components.reduce((sum, entry) => sum + BigInt(entry.chargeAmountNanos), 0n)
  return {
    status: "rated",
    money: { currency: rateCard.currency, amountNanos: total.toString() },
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

function partitionInputUsage(usage: ModelUsage, rateCard: LanguageModelRateCard): PartitionResult {
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
          cacheWrite5m: usage.cacheWrite5mInputTokens ?? 0,
          cacheWrite1h: usage.cacheWrite1hInputTokens ?? 0,
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
