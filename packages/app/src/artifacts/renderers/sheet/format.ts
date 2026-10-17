import { isArtifactAddress, parseSheetDate, parseSheetNumber } from "@sixb/core/artifacts"
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
}

/**
 * How a column's values read in the reader's locale: grouped numbers, the column's currency and
 * decimals, percents from fractions, dates without a time zone shift, links by their address.
 * A value that does not read as its type shows as written.
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
      const formatter = new Intl.NumberFormat(locale, {
        ...(format.type === "currency"
          ? { style: "currency", currency: format.currency ?? "USD" }
          : format.type === "percent"
            ? { style: "percent" }
            : {}),
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      })
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
    case "text":
      return (value) => ({ text: value })
  }
}

/** A short form for chart axes: `$4.1M`, `35%`, `12K`. */
export function compactFormatter(column: SheetColumn, locale: string): (value: number) => string {
  const { format } = column
  const formatter = new Intl.NumberFormat(locale, {
    ...(format.type === "currency"
      ? { style: "currency", currency: format.currency ?? "USD" }
      : format.type === "percent"
        ? { style: "percent" }
        : {}),
    notation: format.type === "percent" ? "standard" : "compact",
    maximumFractionDigits: format.type === "percent" ? Math.min(column.decimals, 1) : 1,
  })
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
  const compact = new Intl.NumberFormat(locale, {
    ...(format.type === "currency"
      ? { style: "currency", currency: format.currency ?? "USD" }
      : {}),
    notation: "compact",
    maximumSignificantDigits: 3,
  })
  return (value) => {
    const number = parseSheetNumber(value)
    if (number === undefined || Math.abs(number) < 10_000) return full(value)
    return { text: compact.format(number), ...(number < 0 ? { negative: true } : {}) }
  }
}
