import { parseSheetNumber, type SheetHighlight, type SheetTone } from "@sixb/core/artifacts"
import type { SheetModel } from "./model"

/** A highlighted column's values from least to greatest, across every row of the sheet. */
export interface HighlightRange {
  readonly highlight: SheetHighlight
  readonly min: number
  readonly max: number
}

/**
 * The span each highlighted column's values cover. It is the whole sheet's, as a spreadsheet's
 * conditional format is the column's: a filter or sort leaves every shade where it was.
 */
export function highlightRanges(model: SheetModel): ReadonlyMap<number, HighlightRange> {
  const ranges = new Map<number, HighlightRange>()
  model.columns.forEach((column, index) => {
    const highlight = column.format.highlight
    if (!highlight) return
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    for (const row of model.rows) {
      const number = parseSheetNumber(row[index] ?? "")
      if (number === undefined) continue
      min = Math.min(min, number)
      max = Math.max(max, number)
    }
    if (min <= max) ranges.set(index, { highlight, min, max })
  })
  return ranges
}

/** How one cell is highlighted: a bar's extent in the cell, or a shade behind it. */
export type CellHighlight =
  | { readonly kind: "bar"; readonly from: number; readonly to: number; readonly negative: boolean }
  | { readonly kind: "shade"; readonly color: string }

/**
 * A value's highlight in its column. A bar runs from zero, or from the column's least value when
 * every value is past zero, so a column of all equal values fills its cells. A scale shades from
 * light at the least value to dark at the greatest, and the middle when all are equal. Diverging
 * shades positive values in the theme's success color and negative ones in its destructive color,
 * deeper the farther from zero. An empty cell or one that is not a number has none.
 */
export function cellHighlight(range: HighlightRange, value: string): CellHighlight | undefined {
  const number = parseSheetNumber(value)
  if (number === undefined) return undefined
  const { min, max } = range
  switch (range.highlight) {
    case "bars": {
      const low = Math.min(0, min)
      const high = Math.max(0, max)
      if (high === low) return undefined
      const at = (point: number) => (point - low) / (high - low)
      const zero = at(0)
      const end = at(number)
      return {
        kind: "bar",
        from: Math.min(zero, end),
        to: Math.max(zero, end),
        negative: number < 0,
      }
    }
    case "scale": {
      const share = max === min ? 0.5 : (number - min) / (max - min)
      return { kind: "shade", color: mix("var(--foreground)", 3 + share * 14) }
    }
    case "diverging": {
      const reach = Math.max(Math.abs(min), Math.abs(max))
      if (number === 0 || reach === 0) return undefined
      const share = Math.abs(number) / reach
      return {
        kind: "shade",
        color: mix(number > 0 ? "var(--success)" : "var(--destructive)", 5 + share * 19),
      }
    }
  }
}

/** A theme color mixed into the cell's background, `percent` of it. */
function mix(color: string, percent: number): string {
  return `color-mix(in oklab, ${color} ${Math.round(percent)}%, var(--sheet-cell))`
}

/** Each tone's color in the theme. */
export const TONE_COLORS: Readonly<Record<SheetTone, string>> = {
  neutral: "var(--muted-foreground)",
  positive: "var(--success)",
  warning: "var(--warning)",
  negative: "var(--destructive)",
  "chart-1": "var(--chart-1)",
  "chart-2": "var(--chart-2)",
  "chart-3": "var(--chart-3)",
  "chart-4": "var(--chart-4)",
  "chart-5": "var(--chart-5)",
}
