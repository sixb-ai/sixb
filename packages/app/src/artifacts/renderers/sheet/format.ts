import {
  isArtifactAddress,
  parseSheetDate,
  parseSheetNumber,
  type SheetColumnFormat,
  type SheetTone,
} from "@sixb/core/artifacts"
import type { SheetColumn } from "./model"

/** A cell as the grid shows it. */
export interface FormattedCell {
  readonly text: string
  readonly negative?: boolean
  /** A link cell's address. */
  readonly href?: string
  /** An `artifact:` address in a link or image cell, which opens where the reader is. */
  readonly reference?: string
  /** An image cell's path in the artifact. */
  readonly image?: string
  /** A number in a text column, which aligns right as a spreadsheet aligns any number. */
  readonly number?: boolean
  /** A boolean cell's value, drawn as a checkbox. */
  readonly check?: boolean
  /** A tag cell's tone, drawn as a chip in it. */
  readonly tag?: SheetTone
}

/**
 * A number formatter for the reader's locale, in a column's style when one is given: its currency,
 * percents from fractions, and a sign on positive values for a signed column. Formatters are built
 * once for each locale and options, since a sheet asks for the same few on every cell it draws.
 */
export function numberFormat(
  locale: string,
  options: Intl.NumberFormatOptions,
  format?: SheetColumnFormat
): Intl.NumberFormat {
  const resolved: Intl.NumberFormatOptions = {
    ...(format?.type === "currency"
      ? { style: "currency", currency: format.currency ?? "USD" }
      : format?.type === "percent"
        ? { style: "percent" }
        : {}),
    ...(format?.signed ? { signDisplay: "exceptZero" } : {}),
    ...options,
  }
  const key = `${locale}\u0000${JSON.stringify(resolved)}`
  let formatter = NUMBER_FORMATS.get(key)
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, resolved)
    NUMBER_FORMATS.set(key, formatter)
  }
  return formatter
}

const NUMBER_FORMATS = new Map<string, Intl.NumberFormat>()

/** A currency's sign as a column header shows it beside the name: `$`, `€`, `£`. */
export function currencySymbol(currency: string): string {
  return (
    numberFormat("en", { style: "currency", currency, currencyDisplay: "narrowSymbol" })
      .formatToParts(0)
      .find((part) => part.type === "currency")?.value ?? currency
  )
}

/**
 * How a column's values read in the reader's locale: grouped or compact numbers, the column's
 * currency, decimals, and sign, percents from fractions, dates without a time zone shift, links by
 * their address. A value that does not read as its type shows as written.
 */
export function cellFormatter(
  column: SheetColumn,
  locale: string
): (value: string) => FormattedCell {
  const { format, decimals } = column
  switch (format.type) {
    case "number":
    case "currency":
    case "percent": {
      const formatter = numberFormat(
        locale,
        // Compact keeps one decimal unless the format says otherwise, so a column reads alike:
        // `$2.0M` beside `$1.5M`.
        format.compact
          ? {
              notation: "compact",
              minimumFractionDigits: format.decimals ?? 1,
              maximumFractionDigits: format.decimals ?? 1,
            }
          : { minimumFractionDigits: decimals, maximumFractionDigits: decimals },
        format
      )
      return (value) => {
        const number = parseSheetNumber(value)
        if (number === undefined) return { text: value }
        return { text: formatter.format(number), ...(number < 0 ? { negative: true } : {}) }
      }
    }
    case "date": {
      const dateOnly = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" })
      const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" })
      return (value) => {
        const date = parseSheetDate(value)
        if (!date) return { text: value }
        return { text: (value.trim().length === 10 ? dateOnly : dateTime).format(date) }
      }
    }
    case "link":
      return (value) => {
        const href = value.trim()
        if (isArtifactAddress(href)) return { text: href, reference: href }
        if (!/^https?:\/\//i.test(href)) return { text: value }
        return { text: href.replace(/^https?:\/\//i, "").replace(/\/$/, ""), href }
      }
    case "image":
      return (value) => {
        const path = value.trim()
        if (isArtifactAddress(path)) return { text: path, reference: path }
        return path ? { text: path.split("/").at(-1) ?? path, image: path } : { text: "" }
      }
    case "boolean":
      // TRUE and FALSE, as a spreadsheet writes them: what find, filters, and copies read.
      return (value) => {
        const word = value.trim().toLowerCase()
        if (word !== "true" && word !== "false") return { text: value }
        return { text: word.toUpperCase(), check: word === "true" }
      }
    case "tag":
      return (value) => {
        const tag = value.trim()
        return tag ? { text: tag, tag: format.tones?.[tag] ?? "neutral" } : { text: "" }
      }
    case "text":
      return (value) =>
        parseSheetNumber(value) === undefined ? { text: value } : { text: value, number: true }
  }
}

/** A short form for chart axes: `$4.1M`, `35%`, `12K`. */
export function compactFormatter(column: SheetColumn, locale: string): (value: number) => string {
  const { format } = column
  const formatter = numberFormat(
    locale,
    {
      notation: format.type === "percent" ? "standard" : "compact",
      maximumFractionDigits: format.type === "percent" ? Math.min(column.decimals, 1) : 1,
    },
    format
  )
  return (value) => formatter.format(value)
}

/**
 * Cells for a glance, as a card previews a sheet: large numbers and amounts read compactly to
 * three significant digits (`$4.12M`); everything else reads as the grid shows it.
 */
export function previewFormatter(
  column: SheetColumn,
  locale: string
): (value: string) => FormattedCell {
  const full = cellFormatter(column, locale)
  const { format } = column
  if (format.type !== "number" && format.type !== "currency") return full
  const compact = numberFormat(locale, { notation: "compact", maximumSignificantDigits: 3 }, format)
  return (value) => {
    const number = parseSheetNumber(value)
    if (number === undefined || Math.abs(number) < 10_000) return full(value)
    return { text: compact.format(number), ...(number < 0 ? { negative: true } : {}) }
  }
}
