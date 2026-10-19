import {
  isArtifactAddress,
  parseSheetDate,
  parseSheetNumber,
  type SheetColumnFormat,
} from "@sixb/core/artifacts"

/** Why what a reader typed can't be a column's value: the column's type, which says what fits. */
export type CellInputError = "number" | "date" | "link" | "image" | "boolean"

/** What a cell stores from what a reader typed, or why it can't. */
export type CellInput = { readonly value: string } | { readonly error: CellInputError }

/**
 * Reads what a reader typed into a cell as the column's type stores it, in the reader's locale:
 * `12%` in a percent column is `0.12`, `$1,200` in a currency column is `1200`, `23/11/2026` is
 * `2026-11-23` where the day comes first. Empty is always a value: the cell is cleared.
 */
export function parseCellInput(
  text: string,
  format: SheetColumnFormat,
  locale: string,
  options: {
    /** Whether a path is one of the artifact's images. */
    readonly image?: (path: string) => boolean
  } = {}
): CellInput {
  const trimmed = text.trim()
  if (!trimmed) return { value: "" }
  switch (format.type) {
    case "number":
    case "currency": {
      const number = localeNumber(trimmed, locale, format.type === "currency")
      return number === undefined ? { error: "number" } : { value: String(number) }
    }
    case "percent": {
      // A percent is typed in points, with or without its sign: 12 and 12% are both 0.12.
      const number = localeNumber(trimmed.replace(/\s*%$/, ""), locale, false)
      return number === undefined ? { error: "number" } : { value: String(fraction(number)) }
    }
    case "date": {
      const date = localeDate(trimmed, locale)
      return date === undefined ? { error: "date" } : { value: date }
    }
    case "boolean": {
      const word = trimmed.toLowerCase()
      if (TRUE_WORDS.has(word)) return { value: "true" }
      if (FALSE_WORDS.has(word)) return { value: "false" }
      return { error: "boolean" }
    }
    case "link": {
      if (isArtifactAddress(trimmed) || /^https?:\/\/\S+$/i.test(trimmed)) return { value: trimmed }
      // A bare address, as a reader types one, is a web address.
      return /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(trimmed)
        ? { value: `https://${trimmed}` }
        : { error: "link" }
    }
    case "image":
      return isArtifactAddress(trimmed) || options.image?.(trimmed)
        ? { value: trimmed }
        : { error: "image" }
    case "text":
    case "tag":
      return { value: text }
  }
}

/**
 * A stored value as the reader types it back to change it: a number in the locale's digits
 * without grouping, a percent in points with its sign. What doesn't read as its type is shown
 * as stored.
 */
export function cellInputText(raw: string, format: SheetColumnFormat, locale: string): string {
  switch (format.type) {
    case "number":
    case "currency":
    case "percent": {
      const number = parseSheetNumber(raw)
      if (number === undefined) return raw
      const plain = new Intl.NumberFormat(locale, {
        useGrouping: false,
        maximumFractionDigits: 15,
      })
      return format.type === "percent" ? `${plain.format(points(number))}%` : plain.format(number)
    }
    default:
      return raw
  }
}

const TRUE_WORDS = new Set(["true", "yes", "y", "1", "x", "✓", "✔", "vrai", "oui"])
const FALSE_WORDS = new Set(["false", "no", "n", "0", "faux", "non"])
const MULTIPLIERS: Readonly<Record<string, number>> = { k: 1e3, m: 1e6, b: 1e9, bn: 1e9 }

/** A percent's points as a fraction, without the float noise of a division: 12.3 → 0.123. */
function fraction(points: number): number {
  return Number((points / 100).toPrecision(15))
}

function points(fraction: number): number {
  return Number((fraction * 100).toPrecision(15))
}

/**
 * A number as the locale writes it: its grouping and decimal marks, a leading or trailing minus,
 * accounting parentheses, and `k`, `m`, or `b` for thousands, millions, and billions. A currency
 * may carry its symbol or code.
 */
function localeNumber(text: string, locale: string, currency: boolean): number | undefined {
  const { group, decimal } = separators(locale)
  let value = text.replace(/[\s  ]/g, "")
  if (currency) value = value.replace(/\p{Sc}/gu, "").replace(/^[A-Z]{3}|[A-Z]{3}$/g, "")
  let negative = false
  if (/^\(.*\)$/.test(value)) {
    negative = true
    value = value.slice(1, -1)
  }
  if (/^[-−]/.test(value)) {
    negative = !negative
    value = value.slice(1)
  } else if (/[-−]$/.test(value)) {
    negative = !negative
    value = value.slice(0, -1)
  }
  let multiplier = 1
  const suffix = /(bn|[kmb])$/i.exec(value)
  if (suffix) {
    multiplier = MULTIPLIERS[(suffix[1] as string).toLowerCase()] ?? 1
    value = value.slice(0, -(suffix[1] as string).length)
  }
  // A grouping mark that isn't a space is dropped; the decimal mark becomes a point.
  if (group && !/\s/.test(group)) value = value.split(group).join("")
  if (decimal !== ".") value = value.replace(decimal, ".")
  const number = parseSheetNumber(value)
  if (number === undefined) return undefined
  const signed = negative ? -number : number
  return multiplier === 1 ? signed : Number((signed * multiplier).toPrecision(15))
}

function separators(locale: string): { readonly group: string; readonly decimal: string } {
  const parts = new Intl.NumberFormat(locale).formatToParts(12345.6)
  return {
    group: parts.find((part) => part.type === "group")?.value ?? "",
    decimal: parts.find((part) => part.type === "decimal")?.value ?? ".",
  }
}

/**
 * A date in ISO form or in the locale's order of day, month, and year, with `/`, `.`, or `-`
 * between them and a two-digit year in this century: `YYYY-MM-DD`, or the ISO date and time
 * as typed.
 */
function localeDate(text: string, locale: string): string | undefined {
  if (parseSheetDate(text)) return text
  const fields = text.split(/[/.\-\s]+/).filter(Boolean)
  if (fields.length !== 3 || fields.some((field) => !/^\d{1,4}$/.test(field))) return undefined
  const values: Partial<Record<"day" | "month" | "year", number>> = {}
  dateOrder(locale).forEach((part, index) => {
    values[part] = Number(fields[index])
  })
  const { day, month } = values
  let year = values.year
  if (day === undefined || month === undefined || year === undefined) return undefined
  if (year < 100) year += 2000
  const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
  const date = parseSheetDate(iso)
  // A day past the month's end rolls over in a Date: the 31st of April is no date.
  return date && date.getUTCDate() === day && date.getUTCMonth() + 1 === month ? iso : undefined
}

function dateOrder(locale: string): readonly ("day" | "month" | "year")[] {
  return new Intl.DateTimeFormat(locale, { year: "numeric", month: "numeric", day: "numeric" })
    .formatToParts(new Date(2026, 10, 23))
    .flatMap((part) =>
      part.type === "day" || part.type === "month" || part.type === "year" ? [part.type] : []
    )
}
