import type {
  GetAiAccountingOverviewResponse,
  GetAiLimitSubjectOptionsResponse,
} from "@sixb/client"

export type Overview = GetAiAccountingOverviewResponse

export interface Money {
  readonly currency: string
  readonly amountNanos: string
}

export type LimitMeter = "tokens.total" | "cost.catalogEstimated"

export type LimitQuantity =
  | { readonly meter: "tokens.total"; readonly amount: number }
  | {
      readonly meter: "cost.catalogEstimated"
      readonly amount: { readonly currency: "USD"; readonly amountNanos: string }
    }

/** Why a typed limit amount was refused; the form says it in the reader's language. */
type LimitAmountError =
  | "separators"
  | "wholeTokens"
  | "tooManyTokens"
  | "currency"
  | "costFormat"
  | "costTooLarge"

type LimitAmountParse =
  | { readonly ok: true; readonly quantity: LimitQuantity }
  | { readonly ok: false; readonly error: LimitAmountError }

/**
 * A typed limit amount, exactly. Separators are refused rather than guessed: `1,50` is one and a
 * half in some languages and a hundred and fifty in others.
 */
export function parseLimitAmount(
  meter: LimitMeter,
  input: string,
  currencyInput = "USD"
): LimitAmountParse {
  const amount = input.trim()
  if (/[,\s]/.test(amount)) return { ok: false, error: "separators" }
  if (meter === "tokens.total") {
    if (!/^\d+$/.test(amount)) return { ok: false, error: "wholeTokens" }
    const tokens = Number(amount)
    if (!Number.isSafeInteger(tokens)) return { ok: false, error: "tooManyTokens" }
    return { ok: true, quantity: { meter, amount: tokens } }
  }
  if (currencyInput.trim().toUpperCase() !== "USD") return { ok: false, error: "currency" }
  const match = /^(\d+)(?:\.(\d{0,9}))?$/.exec(amount)
  if (!match) return { ok: false, error: "costFormat" }
  const nanos = BigInt(match[1]) * 1_000_000_000n + BigInt((match[2] ?? "").padEnd(9, "0"))
  if (nanos > 9_223_372_036_854_775_807n) return { ok: false, error: "costTooLarge" }
  return {
    ok: true,
    quantity: { meter, amount: { currency: "USD", amountNanos: nanos.toString() } },
  }
}

/** A limit's amount as the form's input shows it. */
export function limitAmountInput(quantity: LimitQuantity): string {
  if (quantity.meter === "tokens.total") return quantity.amount.toString()
  const nanos = BigInt(quantity.amount.amountNanos)
  const fraction = (nanos % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "")
  const whole = (nanos / 1_000_000_000n).toString()
  return fraction ? `${whole}.${fraction}` : whole
}

/** A limit's amount rounded for reading: tokens in full, cost to the digits that matter. */
export function formatLimitQuantity(
  quantity: LimitQuantity,
  tokens: (count: string) => string,
  locale = "en"
): string {
  if (quantity.meter === "tokens.total") return tokens(quantity.amount.toLocaleString(locale))
  const nanos = BigInt(quantity.amount.amountNanos)
  if (nanos > 0n && nanos < 1_000n) {
    return `${quantity.amount.currency} <${(0.000001).toLocaleString(locale, { maximumFractionDigits: 6 })}`
  }
  const value = Number(nanos) / 1_000_000_000
  const maximumFractionDigits = value === 0 ? 2 : value < 0.01 ? 6 : value < 1 ? 4 : 2
  return `${quantity.amount.currency} ${value.toLocaleString(locale, {
    minimumFractionDigits: value === 0 || value >= 1 ? 2 : 0,
    maximumFractionDigits,
  })}`
}

/** How much of a limit is spoken for: what was used, plus what is reserved or of unknown outcome. */
export function limitUsedPercent(input: {
  readonly limit: LimitQuantity
  readonly actual: LimitQuantity
  readonly reserved: LimitQuantity
  readonly unknown: LimitQuantity
}): number {
  const limit = quantityAmount(input.limit)
  if (limit === 0n) return 100
  const committed =
    quantityAmount(input.actual) + quantityAmount(input.reserved) + quantityAmount(input.unknown)
  return Math.min(100, Number((committed * 100_000_000n) / limit) / 1_000_000)
}

export function quantityIsPositive(quantity: LimitQuantity): boolean {
  return quantityAmount(quantity) > 0n
}

function quantityAmount(quantity: LimitQuantity): bigint {
  return quantity.meter === "tokens.total"
    ? BigInt(quantity.amount)
    : BigInt(quantity.amount.amountNanos)
}

export type LimitSubjectType = "group" | "user" | "serviceAccount"

interface LimitSubjectChoice {
  readonly value: string
  readonly label: string
  readonly description?: string
}

/** The groups, people or service accounts a limit can apply to, named as a person reads them. */
export function limitSubjectChoices(
  options: GetAiLimitSubjectOptionsResponse | undefined,
  type: LimitSubjectType,
  statusLabels: { readonly active: string; readonly suspended: string }
): readonly LimitSubjectChoice[] {
  if (!options) return []
  if (type === "group") {
    return options.groups.map((group) => ({
      value: group.id,
      label: group.label ?? group.id,
      ...(group.description === undefined ? {} : { description: group.description }),
    }))
  }
  if (type === "user") {
    return options.users.map((user) => ({
      value: user.id,
      label: user.displayName?.trim() || user.email,
      description: [user.displayName?.trim() ? user.email : undefined, statusLabels[user.status]]
        .filter(Boolean)
        .join(" · "),
    }))
  }
  return options.serviceAccounts.map((account) => ({
    value: account.id,
    label: account.name,
    description: [account.description, statusLabels[account.status]].filter(Boolean).join(" · "),
  }))
}

export function amountFor(amounts: readonly Money[], currency: string | undefined) {
  return currency ? amounts.find((amount) => amount.currency === currency) : undefined
}

export function nanosToNumber(amountNanos: string | undefined): number {
  return amountNanos === undefined ? 0 : Number(amountNanos) / 1_000_000_000
}

export function formatChartMoney(
  value: number,
  currency: string | undefined,
  locale = "en"
): string {
  if (!currency) return value.toLocaleString(locale, { maximumFractionDigits: 4 })
  const maximumFractionDigits = value === 0 ? 2 : value < 0.01 ? 6 : value < 1 ? 4 : 2
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    maximumFractionDigits,
  }).format(value)
}
