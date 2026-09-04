import type { GetAiLimitSubjectOptionsResponse } from "@sixb/client"
import { humanizeIdentifier } from "./labels"

export type AiLimitFormMeter = "tokens.total" | "cost.catalogEstimated"
export type AiLimitSelectableSubjectType = "group" | "user" | "serviceAccount"
export type AiLimitSubjectOptions = GetAiLimitSubjectOptionsResponse

export interface AiLimitSubjectChoice {
  readonly value: string
  readonly label: string
  readonly description?: string
}

export type AiLimitFormQuantity =
  | { readonly meter: "tokens.total"; readonly amount: number }
  | {
      readonly meter: "cost.catalogEstimated"
      readonly amount: { readonly currency: "USD"; readonly amountNanos: string }
    }

export type AiLimitFormParseResult =
  | { readonly ok: true; readonly quantity: AiLimitFormQuantity }
  | { readonly ok: false; readonly error: string }

export function parseAiLimitFormQuantity(
  meter: AiLimitFormMeter,
  amountInput: string,
  currencyInput = "USD"
): AiLimitFormParseResult {
  const amount = amountInput.trim().replaceAll(",", "")
  if (meter === "tokens.total") {
    if (!/^\d+$/.test(amount)) {
      return { ok: false, error: "Enter a whole, non-negative token amount." }
    }
    const tokens = Number(amount)
    if (!Number.isSafeInteger(tokens)) {
      return { ok: false, error: "Token amount is too large." }
    }
    return { ok: true, quantity: { meter, amount: tokens } }
  }

  const currency = currencyInput.trim().toUpperCase()
  if (currency !== "USD") {
    return { ok: false, error: "Catalog-estimated limits use USD." }
  }
  const match = /^(\d+)(?:\.(\d{0,9}))?$/.exec(amount)
  if (!match) {
    return { ok: false, error: "Enter a non-negative amount with at most nine decimal places." }
  }
  const whole = BigInt(match[1])
  const fraction = BigInt((match[2] ?? "").padEnd(9, "0"))
  const amountNanos = whole * 1_000_000_000n + fraction
  if (amountNanos > 9_223_372_036_854_775_807n) {
    return { ok: false, error: "Cost amount is too large." }
  }
  return {
    ok: true,
    quantity: {
      meter,
      amount: { currency: "USD", amountNanos: amountNanos.toString() },
    },
  }
}

export function aiLimitAmountInput(quantity: AiLimitFormQuantity): string {
  if (quantity.meter === "tokens.total") return quantity.amount.toString()
  const nanos = BigInt(quantity.amount.amountNanos)
  const whole = nanos / 1_000_000_000n
  const fraction = (nanos % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "")
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

export function formatAiLimitQuantity(quantity: AiLimitFormQuantity): string {
  if (quantity.meter === "tokens.total") {
    return `${quantity.amount.toLocaleString()} tokens`
  }
  const nanos = BigInt(quantity.amount.amountNanos)
  if (nanos > 0n && nanos < 1_000n) return `${quantity.amount.currency} <0.000001`
  const value = Number(nanos) / 1_000_000_000
  const maximumFractionDigits = value === 0 ? 2 : value < 0.01 ? 6 : value < 1 ? 4 : 2
  return `${quantity.amount.currency} ${value.toLocaleString(undefined, {
    minimumFractionDigits: value === 0 || value >= 1 ? 2 : 0,
    maximumFractionDigits,
  })}`
}

export function formatAiLimitQuantityExact(quantity: AiLimitFormQuantity): string {
  if (quantity.meter === "tokens.total") {
    return `${quantity.amount.toLocaleString()} tokens`
  }
  const nanos = BigInt(quantity.amount.amountNanos)
  const whole = nanos / 1_000_000_000n
  const fraction = (nanos % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "")
  return `${quantity.amount.currency} ${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ".00"}`
}

export function aiLimitUsagePercent(input: {
  readonly limit: AiLimitFormQuantity
  readonly actual: AiLimitFormQuantity
  readonly reserved: AiLimitFormQuantity
  readonly unknown: AiLimitFormQuantity
}): number {
  const limit = quantityAmount(input.limit)
  if (limit === 0n) return 100
  const committed =
    quantityAmount(input.actual) + quantityAmount(input.reserved) + quantityAmount(input.unknown)
  const millionthsOfPercent = (committed * 100_000_000n) / limit
  return Math.min(100, Number(millionthsOfPercent) / 1_000_000)
}

export function aiLimitSubjectChoices(
  options: AiLimitSubjectOptions | undefined,
  type: AiLimitSelectableSubjectType
): readonly AiLimitSubjectChoice[] {
  if (!options) return []
  if (type === "group") {
    return options.groups.map((group) => ({
      value: group.id,
      label: group.label ?? humanizeIdentifier(group.id),
      ...(group.description === undefined ? {} : { description: group.description }),
    }))
  }
  if (type === "user") {
    return options.users.map((user) => ({
      value: user.id,
      label: user.displayName?.trim() || user.email,
      description: [user.displayName?.trim() ? user.email : undefined, statusLabel(user.status)]
        .filter(Boolean)
        .join(" · "),
    }))
  }
  return options.serviceAccounts.map((serviceAccount) => ({
    value: serviceAccount.id,
    label: serviceAccount.name,
    description: [serviceAccount.description, statusLabel(serviceAccount.status)]
      .filter(Boolean)
      .join(" · "),
  }))
}

export function aiLimitSubjectLabel(
  subject:
    | { readonly type: "project" }
    | { readonly type: AiLimitSelectableSubjectType; readonly id: string },
  options?: AiLimitSubjectOptions
): string {
  if (subject.type === "project") return "Current project"
  const choice = aiLimitSubjectChoices(options, subject.type).find(
    (option) => option.value === subject.id
  )
  if (choice) return choice.label
  if (subject.type === "serviceAccount") return `Service account · ${subject.id}`
  return `${subject.type === "group" ? "Group" : "User"} · ${subject.id}`
}

function quantityAmount(quantity: AiLimitFormQuantity): bigint {
  return quantity.meter === "tokens.total"
    ? BigInt(quantity.amount)
    : BigInt(quantity.amount.amountNanos)
}

function statusLabel(status: "active" | "suspended"): string {
  return status === "active" ? "Active" : "Suspended"
}
