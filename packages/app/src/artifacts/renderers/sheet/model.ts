import {
  type CsvTable,
  evaluateComputedColumns,
  NUMERIC_COLUMN_TYPES,
  parseSheetNumber,
  type SheetColumnFormat,
  type SheetTotal,
  type WorkbookSheet,
} from "@sixb/core/artifacts"

/** One column as the grid draws it. */
export interface SheetColumn {
  readonly name: string
  readonly format: SheetColumnFormat
  readonly numeric: boolean
  /** Digits after the decimal point: the format's, else as many as the column's values need. */
  readonly decimals: number
  readonly width: number
  /** What the column means, from the workbook. */
  readonly description?: string
  /** What the totals row shows under it. */
  readonly total?: SheetTotal
}

/** A sheet ready to draw: its columns, and its data rows each as wide as the columns. */
export interface SheetModel {
  readonly name: string
  readonly columns: readonly SheetColumn[]
  readonly rows: readonly (readonly string[])[]
  /** Grid rows that stay in view, the header row included. */
  readonly frozenRows: number
  readonly frozenColumns: number
  /** Whether a totals row is pinned under the rows: some column has a total. */
  readonly totals: boolean
}

type SheetLayout = Pick<
  WorkbookSheet,
  "name" | "frozenRows" | "frozenColumns" | "columns" | "widths"
> &
  Partial<Pick<WorkbookSheet, "descriptions" | "totals">>

/**
 * A sheet of a workbook, laid out as its workbook says, its computed columns filled. Publishing
 * refused formulas that can't compute, so they all do here.
 */
export function sheetModel(sheet: SheetLayout, source: CsvTable): SheetModel {
  const table = evaluateComputedColumns(sheet, source).table
  const columns = table.header.map((name, index) => {
    const format = sheet.columns[name] ?? { type: "text" as const }
    const description = sheet.descriptions?.[name]
    const total = sheet.totals?.[name]
    return {
      ...column(name, format, table.rows, index, sheet.widths[name]),
      ...(description ? { description } : {}),
      ...(total ? { total } : {}),
    }
  })
  return {
    name: sheet.name,
    columns,
    rows: table.rows.map((row) => pad(row, columns.length)),
    frozenRows: Math.min(sheet.frozenRows, table.rows.length + 1),
    frozenColumns: Math.min(sheet.frozenColumns, columns.length),
    totals: columns.some((entry) => entry.total),
  }
}

/**
 * A plain CSV file as a sheet: a column whose values are all numbers reads as numbers, any other
 * as text, and rows longer than the header add unnamed columns.
 */
export function fileSheetModel(name: string, table: CsvTable): SheetModel {
  // A loop, not a spread: a long file's rows are more arguments than a call can take.
  let width = table.header.length
  for (const row of table.rows) width = Math.max(width, row.length)
  const header = Array.from({ length: width }, (_, index) => table.header[index] ?? "")
  const columns = header.map((columnName, index) => {
    const values = table.rows.map((row) => row[index] ?? "").filter((value) => value.trim())
    const numeric =
      values.length > 0 && values.every((value) => parseSheetNumber(value) !== undefined)
    return column(columnName, { type: numeric ? "number" : "text" }, table.rows, index, undefined)
  })
  return {
    name,
    columns,
    rows: table.rows.map((row) => pad(row, width)),
    frozenRows: 1,
    frozenColumns: 0,
    totals: false,
  }
}

const SAMPLE_ROWS = 200
const CHARACTER_WIDTH = 7.4
const HEADER_CHARACTER_WIDTH = 7.8
const MIN_WIDTH = 72
const MAX_WIDTH = 320

function column(
  name: string,
  format: SheetColumnFormat,
  rows: readonly (readonly string[])[],
  index: number,
  width: number | undefined
): SheetColumn {
  const numeric = NUMERIC_COLUMN_TYPES.includes(format.type)
  const sample = rows.slice(0, SAMPLE_ROWS).map((row) => row[index] ?? "")
  return {
    name,
    format,
    numeric,
    decimals: format.decimals ?? (numeric ? neededDecimals(sample, format.type) : 0),
    width: width ?? estimatedWidth(name, sample, format),
  }
}

/** As many decimals as the values carry, capped where more would be noise. */
function neededDecimals(values: readonly string[], type: SheetColumnFormat["type"]): number {
  const cap = type === "number" ? 4 : 2
  let decimals = 0
  for (const value of values) {
    const number = parseSheetNumber(value)
    if (number === undefined) continue
    const scaled = type === "percent" ? number * 100 : number
    const text = String(Math.abs(Number(scaled.toFixed(cap))))
    const point = text.indexOf(".")
    if (point >= 0) decimals = Math.max(decimals, text.length - point - 1)
    if (decimals === cap) break
  }
  return decimals
}

/** A width that fits the header and most values without measuring text. */
function estimatedWidth(
  name: string,
  sample: readonly string[],
  format: SheetColumnFormat
): number {
  // Formatting adds currency signs, grouping, month names, and a tag's chip; compact takes digits
  // away, and a checkbox is narrow.
  const extra = format.compact
    ? -2
    : format.type === "currency" || format.type === "tag"
      ? 4
      : format.type === "number" || format.type === "date"
        ? 2
        : 0
  const longest = Math.max(
    ...sample.map((value) => value.length + extra),
    format.type === "image" ? 4 : 0
  )
  // The header is semibold, beside its type glyph and sort control.
  const header = name.length * HEADER_CHARACTER_WIDTH + (format.type === "text" ? 0 : 18) + 54
  const values = longest * CHARACTER_WIDTH + 28
  return Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, header, values)))
}

function pad(row: readonly string[], width: number): readonly string[] {
  return row.length >= width
    ? row
    : [...row, ...Array.from({ length: width - row.length }, () => "")]
}
