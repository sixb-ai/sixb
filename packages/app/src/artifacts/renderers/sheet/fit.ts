import type { FormattedCell } from "./format"
import type { SheetColumn } from "./model"

/** The width of a text in pixels, in the grid's font: semibold for the header. */
export type TextMeasure = (text: string, bold: boolean) => number

/** How many rows a fit reads, spread evenly over the sheet, so a long sheet fits as quickly. */
const FIT_SAMPLE_ROWS = 2_000
/** A cell's padding and border around its text. */
const CELL_CHROME = 24
/** The header's type glyph, sort control, and the gaps between them. */
const HEADER_CHROME = 54
const GLYPH_WIDTH = 18
/** An image cell's thumbnail and the gap after it. */
const THUMBNAIL_WIDTH = 32

/**
 * The width that shows a column's name and its widest value whole, as a spreadsheet fits a column
 * when its edge is double-clicked. The caller clamps it to the grid's limits.
 */
export function fitWidth(
  column: SheetColumn,
  index: number,
  rows: readonly (readonly string[])[],
  format: (value: string) => FormattedCell,
  measure: TextMeasure
): number {
  const glyph = column.format.type === "text" ? 0 : GLYPH_WIDTH
  let widest = measure(column.name, true) + HEADER_CHROME + glyph
  const step = Math.max(1, rows.length / FIT_SAMPLE_ROWS)
  for (let at = 0; at < rows.length; at += step) {
    const value = rows[Math.floor(at)]?.[index] ?? ""
    if (!value.trim()) continue
    const cell = format(value)
    const width = measure(cell.text, false) + (cell.image ? THUMBNAIL_WIDTH : 0) + CELL_CHROME
    widest = Math.max(widest, width)
  }
  return Math.ceil(widest)
}

/**
 * Measures text in the font an element is set in, through a canvas. Without one, as outside a
 * browser, it reads a typical character width.
 */
export function elementTextMeasure(element: HTMLElement | null): TextMeasure {
  const context =
    typeof document === "undefined" ? null : document.createElement("canvas").getContext?.("2d")
  if (!context?.measureText || !element) return (text, bold) => text.length * (bold ? 7.8 : 7.4)
  const { fontSize, fontFamily } = getComputedStyle(element)
  return (text, bold) => {
    context.font = `${bold ? 600 : 400} ${fontSize} ${fontFamily}`
    return context.measureText(text).width
  }
}
