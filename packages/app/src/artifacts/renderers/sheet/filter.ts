import { parseSheetDate, parseSheetNumber } from "@sixb/core/artifacts"
import type { SheetColumn, SheetModel } from "./model"

/**
 * What a reader keeps of one column. A values filter hides the values it names, as the sheet
 * stores them, so a value the panel never listed stays shown. A condition compares numbers as
 * numbers and dates by their day, against what the reader typed: a number in their locale, a
 * percent in percent (`25` for 25%), a date as `YYYY-MM-DD`.
 */
export type ColumnFilter =
  | { readonly kind: "values"; readonly excluded: readonly string[] }
  | {
      readonly kind: "condition"
      readonly op: FilterOperator
      readonly value?: string
      /** The upper end, for `between`. */
      readonly to?: string
    }

export const FILTER_OPERATORS = [
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  "empty",
  "notEmpty",
] as const
export type FilterOperator = (typeof FILTER_OPERATORS)[number]

/** Columns whose cells compare by condition rather than by value. */
export function filtersByCondition(column: SheetColumn): boolean {
  return column.numeric || column.format.type === "date"
}

/** The rows of `order` every filter keeps, in that order. */
export function filteredOrder(
  model: SheetModel,
  order: readonly number[],
  filters: Readonly<Record<number, ColumnFilter>>,
  locale: string
): readonly number[] {
  const tests = Object.entries(filters).flatMap(([key, filter]) => {
    const column = Number(key)
    const entry = model.columns[column]
    return entry ? [{ column, keep: rowTest(entry, filter, locale) }] : []
  })
  if (tests.length === 0) return order
  return order.filter((index) => {
    const row = model.rows[index]
    return !!row && tests.every(({ column, keep }) => keep(row[column] ?? ""))
  })
}

/** Whether a filter keeps every row, as one with nothing excluded or no value to compare does. */
export function isInactiveFilter(filter: ColumnFilter): boolean {
  if (filter.kind === "values") return filter.excluded.length === 0
  if (filter.op === "empty" || filter.op === "notEmpty") return false
  if (!filter.value?.trim()) return true
  return filter.op === "between" && !filter.to?.trim()
}

/** A column's values with how many rows hold each, most frequent first, at most `limit` of them. */
export function distinctValues(
  model: SheetModel,
  column: number,
  limit = 500
): {
  readonly values: readonly { readonly value: string; readonly count: number }[]
  readonly more: number
} {
  const counts = new Map<string, number>()
  for (const row of model.rows) {
    const value = (row[column] ?? "").trim()
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  const values = Array.from(counts, ([value, count]) => ({ value, count })).sort(
    (a, b) => b.count - a.count || a.value.localeCompare(b.value)
  )
  return { values: values.slice(0, limit), more: Math.max(0, values.length - limit) }
}

function rowTest(
  column: SheetColumn,
  filter: ColumnFilter,
  locale: string
): (value: string) => boolean {
  if (isInactiveFilter(filter)) return () => true
  if (filter.kind === "values") {
    const excluded = new Set(filter.excluded)
    return (value) => !excluded.has(value.trim())
  }
  const { op } = filter
  if (op === "empty") return (value) => !value.trim()
  if (op === "notEmpty") return (value) => !!value.trim()
  const read = comparable(column)
  const typed = readFilterInput(column, locale)
  const target = typed(filter.value ?? "")
  const upper = typed(filter.to ?? "")
  if (target === undefined || (op === "between" && upper === undefined)) {
    // A value that is not the column's type matches no cell, so the reader sees their mistake.
    return () => false
  }
  return (value) => {
    const cell = read(value)
    // A cell that is no number or date is not equal to one, and compares as nothing else.
    if (cell === undefined) return op === "ne"
    switch (op) {
      case "eq":
        return same(cell, target)
      case "ne":
        return !same(cell, target)
      case "gt":
        return cell > target
      case "gte":
        return cell >= target
      case "lt":
        return cell < target
      case "lte":
        return cell <= target
      case "between":
        return (
          cell >= Math.min(target, upper ?? target) && cell <= Math.max(target, upper ?? target)
        )
    }
  }
}

/** Equal up to float rounding, so 28.1% typed matches the 0.281 a sheet stores. */
function same(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))
}

/** A cell as a number to compare: its value, or a date's day. */
function comparable(column: SheetColumn): (value: string) => number | undefined {
  if (column.format.type === "date") {
    return (value) => {
      const date = parseSheetDate(value)
      return date ? Math.floor(date.getTime() / DAY_MS) : undefined
    }
  }
  return (value) => (value.trim() ? parseSheetNumber(value) : undefined)
}

/**
 * What a reader typed into a condition, as a number to compare: a date's day, or a number read in
 * their locale's separators, with any currency sign, spaces, or `%` around it; a percent column
 * takes whole percents.
 */
export function readFilterInput(
  column: SheetColumn,
  locale: string
): (text: string) => number | undefined {
  if (column.format.type === "date") return comparable(column)
  const decimal =
    new Intl.NumberFormat(locale).formatToParts(1.5).find((part) => part.type === "decimal")
      ?.value ?? "."
  const scale = column.format.type === "percent" ? 100 : 1
  return (text) => {
    const cleaned = text.replace(/[^\d.,\-+]/g, "")
    if (!/\d/.test(cleaned)) return undefined
    const plain = cleaned
      .split(decimal)
      .map((part) => part.replace(/[.,]/g, ""))
      .join(".")
    const number = parseSheetNumber(plain)
    return number === undefined ? undefined : number / scale
  }
}

const DAY_MS = 24 * 60 * 60 * 1000
