import type {
  GetAiAccountingOverviewData,
  ListAiModelCallGroupsResponse,
  ListAiModelCallsResponse,
} from "@sixb/client"
import { amountFor, nanosToNumber, type Overview } from "./format"

/**
 * What Settings › Usage › Spend reads: the range, the filters that narrow the whole page, and
 * the arithmetic behind its numbers. Filters live in the address, so a narrowed page can be shared.
 */

export type Aggregate = Overview["totals"]
export type Group = ListAiModelCallGroupsResponse["items"][number]
export type GroupExecution = Group["executions"][number]
export type Call = ListAiModelCallsResponse["items"][number]
export type ModelKind = NonNullable<Overview["kinds"][number]["modelKind"]>
type OverviewQuery = GetAiAccountingOverviewData["query"]

const hourMs = 60 * 60 * 1000
const dayMs = 24 * hourMs

export const spendRanges = [
  { id: "24h", bucket: "hour", ms: dayMs, period: "day" },
  { id: "7d", bucket: "day", ms: 7 * dayMs, period: "week" },
  { id: "30d", bucket: "day", ms: 30 * dayMs, period: "month" },
  { id: "90d", bucket: "week", ms: 91 * dayMs, period: "quarter" },
] as const

type SpendRangeId = (typeof spendRanges)[number]["id"]
export type Bucket = (typeof spendRanges)[number]["bucket"]

export interface SpendRange {
  readonly id: SpendRangeId
  readonly from: string
  readonly to: string
  readonly bucket: Bucket
  readonly period: (typeof spendRanges)[number]["period"]
}

/** A range that ends with the current hour or day, so its bars are whole UTC periods. */
export function spendRange(id: string | null, now = Date.now()): SpendRange {
  const preset = spendRanges.find((range) => range.id === id) ?? spendRanges[1]
  const unit = preset.bucket === "hour" ? hourMs : dayMs
  const to = Math.floor(now / unit) * unit + unit
  return {
    id: preset.id,
    from: new Date(to - preset.ms).toISOString(),
    to: new Date(to).toISOString(),
    bucket: preset.bucket,
    period: preset.period,
  }
}

/** The filters that narrow every number on the page, as the address spells them. */
export interface SpendFilters {
  /** The start of one bar: a day, an hour or a week. */
  readonly day?: string
  readonly provider?: string
  readonly model?: string
  /** `user:<id>`, `serviceAccount:<id>`, or `none` for work nobody asked for. */
  readonly person?: string
  /** `agent`, `action`, `other`, or `workflow:<id>`. */
  readonly source?: string
  readonly kind?: ModelKind
  /** Only the calls with no price yet; it narrows the conversations and runs. */
  readonly price?: "unpriceable" | "unvalued"
}

export type FilterKey = keyof SpendFilters

export const filterKeys: readonly FilterKey[] = [
  "day",
  "provider",
  "model",
  "person",
  "source",
  "kind",
  "price",
]

const modelKinds: readonly ModelKind[] = [
  "language",
  "image",
  "video",
  "embedding",
  "decision",
  "transcription",
  "speech",
  "reranking",
]

export function readFilters(params: URLSearchParams): SpendFilters {
  const value = (key: FilterKey) => params.get(key)?.trim() || undefined
  const kind = value("kind")
  const price = value("price")
  const source = value("source")
  const person = value("person")
  return {
    ...(value("day") && !Number.isNaN(Date.parse(value("day")!)) ? { day: value("day") } : {}),
    ...(value("provider") ? { provider: value("provider") } : {}),
    ...(value("model") ? { model: value("model") } : {}),
    ...(person && /^(none|user:.+|serviceAccount:.+)$/.test(person) ? { person } : {}),
    ...(source && /^(agent|action|other|workflow:.+)$/.test(source) ? { source } : {}),
    ...(kind && modelKinds.includes(kind as ModelKind) ? { kind: kind as ModelKind } : {}),
    ...(price === "unpriceable" || price === "unvalued" ? { price } : {}),
  }
}

export function hasFilters(filters: SpendFilters): boolean {
  return filterKeys.some((key) => filters[key] !== undefined)
}

/** The overview filters the API takes, leaving out the day, which narrows the range instead. */
export function apiFilters(
  filters: SpendFilters
): Pick<OverviewQuery, "providerId" | "modelId" | "person" | "source" | "kind"> {
  return {
    ...(filters.provider ? { providerId: filters.provider } : {}),
    ...(filters.model ? { modelId: filters.model } : {}),
    ...(filters.person ? { person: filters.person } : {}),
    ...(filters.source ? { source: filters.source } : {}),
    ...(filters.kind ? { kind: filters.kind } : {}),
  }
}

function bucketMs(bucket: Bucket): number {
  return bucket === "hour" ? hourMs : bucket === "day" ? dayMs : 7 * dayMs
}

/** The range every number is read over: the chosen bar when a day is picked, else the range. */
export function activeRange(range: SpendRange, filters: SpendFilters) {
  if (!filters.day) return { from: range.from, to: range.to }
  const start = Date.parse(filters.day)
  return {
    from: new Date(start).toISOString(),
    to: new Date(Math.min(start + bucketMs(range.bucket), Date.parse(range.to))).toISOString(),
  }
}

/** The period before, as long: the previous bar for a picked day, else the previous range. */
export function priorRange(range: { readonly from: string; readonly to: string }) {
  const from = Date.parse(range.from)
  const span = Date.parse(range.to) - from
  return { from: new Date(from - span).toISOString(), to: new Date(from).toISOString() }
}

// ── Numbers ───────────────────────────────────────────────────────────

export function costOf(aggregate: Pick<Aggregate, "costs"> | undefined, currency?: string) {
  return aggregate ? nanosToNumber(amountFor(aggregate.costs.amounts, currency)?.amountNanos) : 0
}

/** The share of input read from cache, when the calls reported both. */
export function cachedShare(usage: {
  readonly inputTokens?: number
  readonly cacheReadInputTokens?: number
}): number | undefined {
  const { inputTokens, cacheReadInputTokens } = usage
  if (inputTokens === undefined || cacheReadInputTokens === undefined || inputTokens === 0) {
    return undefined
  }
  return cacheReadInputTokens / inputTokens
}

export function unpricedCalls(aggregate: Aggregate | undefined): number {
  return aggregate ? aggregate.costs.unpriceableCallCount + aggregate.costs.unvaluedCallCount : 0
}

// ── Formatting ────────────────────────────────────────────────────────

function currencyFormat(locale: string, currency: string, digits: number) {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

/** An amount to the cent, or "<$0.01" when it is less. */
export function money(value: number, currency = "USD", locale = "en"): string {
  if (value === 0) return currencyFormat(locale, currency, 0).format(0)
  if (value < 0.01) return `<${currencyFormat(locale, currency, 2).format(0.01)}`
  return currencyFormat(locale, currency, 2).format(value)
}

/** An amount precise enough for one call: four decimals under a dollar. */
export function fineMoney(value: number, currency = "USD", locale = "en"): string {
  if (value === 0) return currencyFormat(locale, currency, 0).format(0)
  if (value >= 1) return currencyFormat(locale, currency, 2).format(value)
  if (value >= 0.0001) return currencyFormat(locale, currency, 4).format(value)
  return `<${currencyFormat(locale, currency, 4).format(0.0001)}`
}

/** The hero's amount, its cents apart so they can be set lighter. */
export function splitMoney(value: number, currency = "USD", locale = "en") {
  const parts = currencyFormat(locale, currency, 2).formatToParts(value)
  const decimal = parts.findIndex((part) => part.type === "decimal")
  if (decimal < 0) return { whole: parts.map((part) => part.value).join(""), cents: "" }
  return {
    whole: parts
      .slice(0, decimal)
      .map((part) => part.value)
      .join(""),
    cents: parts
      .slice(decimal)
      .map((part) => part.value)
      .join(""),
  }
}

/** A signed change to the cent, or a dash when there is none to speak of. */
export function signedMoney(value: number, currency = "USD", locale = "en"): string {
  if (Math.abs(value) < 0.005) return "—"
  return `${value > 0 ? "+" : "−"}${money(Math.abs(value), currency, locale)}`
}

export function compact(value: number | undefined, locale = "en"): string {
  if (value === undefined) return "—"
  return new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: value >= 1000 && value < 10_000 ? 1 : value >= 1e6 ? 1 : 0,
  }).format(value)
}

export function percent(value: number | undefined, locale = "en"): string {
  if (value === undefined || Number.isNaN(value)) return "—"
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(value)
}

/** A share of spend to a tenth of a percent, so small rows still read. */
export function sharePercent(value: number, locale = "en"): string {
  if (value > 0 && value < 0.001) return `<${percent(0.001, locale).replace(/\d+/, "0.1")}`
  return new Intl.NumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value)
}

/** A bar's label: its hour, its day, or the week it starts. Buckets are UTC periods. */
export function bucketLabel(start: string, bucket: Bucket, locale = "en"): string {
  const date = new Date(start)
  if (bucket === "hour") {
    return date.toLocaleTimeString(locale, { hour: "numeric", timeZone: "UTC" })
  }
  return date.toLocaleDateString(locale, { month: "short", day: "numeric", timeZone: "UTC" })
}

/** "Oct 23 – 29", "Oct 28 – Nov 3", or one day when the range is one. */
export function rangeLabel(range: { readonly from: string; readonly to: string }, locale = "en") {
  const from = new Date(range.from)
  const last = new Date(Date.parse(range.to) - 1)
  const day = (date: Date, month: boolean) =>
    date.toLocaleDateString(locale, {
      ...(month ? { month: "short" } : {}),
      day: "numeric",
      timeZone: "UTC",
    })
  if (from.toISOString().slice(0, 10) === last.toISOString().slice(0, 10)) return day(from, true)
  const sameMonth = from.getUTCMonth() === last.getUTCMonth()
  return `${day(from, true)} – ${day(last, !sameMonth)}`
}

/** A time today, a day otherwise. */
export function whenLabel(at: string, locale = "en", now = new Date()): string {
  const date = new Date(at)
  const today = date.toDateString() === now.toDateString()
  return today
    ? date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString(locale, { month: "short", day: "numeric" })
}

// ── Model colors ──────────────────────────────────────────────────────

/**
 * The eight costliest models in the range each keep a color everywhere on the page; a ninth and
 * beyond share a gray. Colors follow the model, never its rank under a filter. The order keeps
 * neighbors in a stack apart for color-blind readers too, and dark mode has its own steps of the
 * same hues.
 */
export const modelColors = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
} as const
export const otherModelColor = "#c4c4c0"

export const modelKey = (model: { readonly providerId: string; readonly modelId: string }) =>
  `${model.providerId}/${model.modelId}`

export function modelPalette(
  models: Overview["models"] | undefined,
  currency: string | undefined,
  theme: keyof typeof modelColors = "light"
): ReadonlyMap<string, string> {
  const colors = modelColors[theme]
  const ranked = [...(models ?? [])].sort(
    (a, b) => costOf(b, currency) - costOf(a, currency) || b.modelCallCount - a.modelCallCount
  )
  return new Map(
    ranked.slice(0, colors.length).map((model, index) => [modelKey(model), colors[index]!])
  )
}

export function colorOf(palette: ReadonlyMap<string, string>, key: string): string {
  return palette.get(key) ?? otherModelColor
}

/** Gridlines at a round step, four of them above the baseline. */
export function niceScale(max: number) {
  const rough = (max || 1) / 4
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((m) => m >= rough) ?? rough
  return { step, top: step * 4 }
}

export function downloadCsv(name: string, rows: readonly (readonly (string | number)[])[]) {
  const text = rows
    .map((row) =>
      row
        .map((cell) => {
          const value = String(cell)
          return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
        })
        .join(",")
    )
    .join("\n")
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }))
  const link = document.createElement("a")
  link.href = url
  link.download = name
  link.click()
  URL.revokeObjectURL(url)
}
