import type {
  GetAiAccountingOverviewResponse,
  GetAiLimitSubjectOptionsResponse,
} from "@sixb/client"

export type Overview = GetAiAccountingOverviewResponse
type Aggregate = Overview["totals"]
export type UsageField = keyof Aggregate["usageCoverage"]["fieldCallCounts"]

export interface Money {
  readonly currency: string
  readonly amountNanos: string
}

/** An exact amount: every nanounit the ledger recorded, at least two decimals. */
export function formatMoney(money: Money, locale = "en"): string {
  const nanos = BigInt(money.amountNanos)
  const whole = nanos / 1_000_000_000n
  const fraction = (nanos % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "")
  const decimal = new Intl.NumberFormat(locale)
    .formatToParts(1.5)
    .find((part) => part.type === "decimal")
  return `${money.currency} ${whole.toLocaleString(locale)}${decimal?.value ?? "."}${fraction.padEnd(2, "0")}`
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

/** Every currency a cost was recorded in, so the page can offer them. */
export function currenciesOf(overview: Overview | undefined): string[] {
  if (!overview) return []
  const values = new Set<string>()
  for (const aggregate of [overview.totals, ...overview.series, ...overview.models]) {
    for (const amount of aggregate.costs.amounts) values.add(amount.currency)
  }
  return [...values].sort()
}

/**
 * A period's tokens. An empty period is a known zero; a period whose calls did not report the
 * meter stays unknown, so a chart never implies complete reporting.
 */
export function periodTokens(
  period: Overview["series"][number],
  key: "totalTokens" | "inputTokens" | "outputTokens"
): number | undefined {
  return period.modelCallCount === 0 ? 0 : period.usage[key]
}

// Billed per image, character, audio second or search: these calls mostly report no tokens.
const tokenlessKinds: ReadonlySet<string> = new Set([
  "image",
  "speech",
  "transcription",
  "reranking",
])

/**
 * The calls a token count is owed by: every call of a token-billed kind, and the tokenless calls
 * that reported tokens anyway. Calls recorded before kinds were kept count as token-billed.
 */
export function tokenBilledCalls(overview: Pick<Overview, "kinds" | "totals">): number {
  if (overview.kinds.length === 0) return overview.totals.modelCallCount
  return overview.kinds.reduce(
    (calls, kind) =>
      calls +
      (kind.modelKind !== undefined && tokenlessKinds.has(kind.modelKind)
        ? kind.usageCoverage.completeCallCount
        : kind.modelCallCount),
    0
  )
}

/**
 * One meter as a share of another, only when both cover every call that owes them: equal
 * reporting counts could still describe different calls.
 */
export function usageShare(
  aggregate: Aggregate,
  numerator: UsageField,
  denominator: UsageField,
  expected = aggregate.modelCallCount
): number | undefined {
  const counts = aggregate.usageCoverage.fieldCallCounts
  if (counts[numerator] !== expected) return undefined
  if (counts[denominator] !== expected) return undefined
  const top = aggregate.usage[numerator]
  const bottom = aggregate.usage[denominator]
  if (top === undefined || bottom === undefined || bottom === 0) return undefined
  return (top / bottom) * 100
}

/** How completely the calls that owe usage reported it: every one, some, or none. */
export function reportingCoverage(
  aggregate: Aggregate,
  field?: UsageField,
  expected = aggregate.modelCallCount
): { readonly status: "complete" | "partial" | "unavailable"; readonly count: number } {
  const count = field
    ? aggregate.usageCoverage.fieldCallCounts[field]
    : aggregate.usageCoverage.completeCallCount
  const available = field
    ? aggregate.usage[field] !== undefined
    : aggregate.usage.totalTokens !== undefined
  return {
    status: count >= expected ? "complete" : available ? "partial" : "unavailable",
    count,
  }
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

export function formatCompact(value: number | undefined, locale = "en"): string {
  return value === undefined
    ? "—"
    : new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(value)
}

/** A duration as people say it: "1.25 s", "21 min 25 s", "1 h 4 min". */
export function formatDuration(
  milliseconds: number,
  units: {
    readonly seconds: (value: string) => string
    readonly minutes: (minutes: string, seconds: string) => string
    readonly hours: (hours: string, minutes: string) => string
  },
  locale = "en"
): string {
  const seconds = milliseconds / 1000
  if (seconds < 60) {
    return units.seconds(seconds.toLocaleString(locale, { maximumFractionDigits: 2 }))
  }
  const whole = Math.round(seconds)
  if (whole < 3600) {
    return units.minutes(
      Math.floor(whole / 60).toLocaleString(locale),
      (whole % 60).toLocaleString(locale)
    )
  }
  return units.hours(
    Math.floor(whole / 3600).toLocaleString(locale),
    Math.floor((whole % 3600) / 60).toLocaleString(locale)
  )
}

export function formatPercent(value: number | undefined, locale = "en"): string {
  if (value === undefined) return "—"
  const digits = value >= 99.95 ? 0 : 1
  return `${value.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`
}

const dayMs = 24 * 60 * 60 * 1000

export const rangePresets = [
  { id: "24h", ms: dayMs },
  { id: "7d", ms: 7 * dayMs },
  { id: "30d", ms: 30 * dayMs },
  { id: "1y", ms: 365 * dayMs },
] as const

export type RangePreset = (typeof rangePresets)[number]["id"]

/** Hourly bars for two days or less, weekly past six months, daily between. */
export function bucketFor(range: {
  readonly from: string
  readonly to: string
}): Overview["bucket"] {
  const duration = Date.parse(range.to) - Date.parse(range.from)
  if (duration <= 2 * dayMs) return "hour"
  if (duration > 180 * dayMs) return "week"
  return "day"
}
