import { parseSheetNumber } from "@sixb/core/artifacts"
import type { FormattedCell } from "./format"
import { isLocked, type SheetModel } from "./model"

// Grid coordinates: row 0 is the header row, row 1 the first data row as currently ordered;
// column 0 is the sheet's first column. A1 names count rows from 1, so grid row 0 is row 1.

export interface CellPoint {
  readonly row: number
  readonly column: number
}

export interface CellRange {
  readonly top: number
  readonly left: number
  readonly bottom: number
  readonly right: number
}

export function cellRange(anchor: CellPoint, focus: CellPoint): CellRange {
  return {
    top: Math.min(anchor.row, focus.row),
    left: Math.min(anchor.column, focus.column),
    bottom: Math.max(anchor.row, focus.row),
    right: Math.max(anchor.column, focus.column),
  }
}

export function inRange(range: CellRange, row: number, column: number): boolean {
  return row >= range.top && row <= range.bottom && column >= range.left && column <= range.right
}

/** `A`, `Z`, `AA`, `AB`… */
export function columnLetter(index: number): string {
  let letters = ""
  for (let rest = index + 1; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    letters = String.fromCharCode(65 + ((rest - 1) % 26)) + letters
  }
  return letters
}

/** `B2`, or `B2:D5` for more than one cell. */
export function rangeLabel(range: CellRange): string {
  const start = `${columnLetter(range.left)}${range.top + 1}`
  const end = `${columnLetter(range.right)}${range.bottom + 1}`
  return start === end ? start : `${start}:${end}`
}

export interface RangeStats {
  /** Cells with a value. */
  readonly count: number
  /** Cells that hold a number; the sum and average are theirs. */
  readonly numericCount: number
  readonly sum: number
  readonly average?: number
  readonly min?: number
  readonly max?: number
  /**
   * Cells the reader may not see, in a live sheet: the sum, average, min and max would leave them
   * out, so the status bar shows them locked.
   */
  readonly locked?: number
}

/**
 * What a spreadsheet's status bar says about a selection. Header cells are labels, not values, and
 * hidden columns are left out. A locked cell is counted apart: it is no value the figures read.
 */
export function rangeStats(
  range: CellRange,
  model: SheetModel,
  order: readonly number[],
  hidden: ReadonlySet<number> = NONE_HIDDEN
): RangeStats {
  let count = 0
  let numericCount = 0
  let sum = 0
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  let locked = 0
  for (let row = Math.max(range.top, 1); row <= range.bottom; row += 1) {
    const dataRow = order[row - 1] ?? -1
    const values = model.rows[dataRow]
    if (!values) continue
    for (let column = range.left; column <= range.right; column += 1) {
      if (hidden.has(column)) continue
      if (isLocked(model, dataRow, column)) {
        locked += 1
        continue
      }
      const value = values[column] ?? ""
      if (!value.trim()) continue
      count += 1
      // Any cell that holds a number sums, a text column's too, as in a spreadsheet.
      const number = parseSheetNumber(value)
      if (number === undefined) continue
      numericCount += 1
      sum += number
      min = Math.min(min, number)
      max = Math.max(max, number)
    }
  }
  return {
    count,
    numericCount,
    sum,
    ...(numericCount > 0 ? { average: sum / numericCount, min, max } : {}),
    ...(locked > 0 ? { locked } : {}),
  }
}

/** The selection as tab-separated values, the shape every spreadsheet pastes, hidden columns left out. */
export function rangeTsv(
  range: CellRange,
  model: SheetModel,
  order: readonly number[],
  hidden: ReadonlySet<number> = NONE_HIDDEN
): string {
  const lines: string[] = []
  for (let row = range.top; row <= range.bottom; row += 1) {
    const values =
      row === 0 ? model.columns.map((column) => column.name) : model.rows[order[row - 1] ?? -1]
    if (!values) continue
    lines.push(
      values
        .slice(range.left, range.right + 1)
        .filter((_, index) => !hidden.has(range.left + index))
        .map((value) => value.replace(/[\t\r\n]+/g, " "))
        .join("\t")
    )
  }
  return lines.join("\n")
}

/**
 * The selection as an HTML table of the values as the grid shows them, which a spreadsheet or a
 * document pastes as rows and columns, formats and links kept. The header row is a row of `<th>`.
 */
export function rangeHtml(
  range: CellRange,
  model: SheetModel,
  order: readonly number[],
  formatters: readonly ((value: string) => FormattedCell)[],
  hidden: ReadonlySet<number> = NONE_HIDDEN
): string {
  const rows: string[] = []
  for (let row = range.top; row <= range.bottom; row += 1) {
    const values = row === 0 ? null : model.rows[order[row - 1] ?? -1]
    if (row > 0 && !values) continue
    const cells: string[] = []
    for (let column = range.left; column <= range.right; column += 1) {
      if (hidden.has(column)) continue
      if (!values) {
        cells.push(`<th>${escapeHtml(model.columns[column]?.name ?? "")}</th>`)
        continue
      }
      const cell = formatters[column]?.(values[column] ?? "") ?? { text: values[column] ?? "" }
      const text = escapeHtml(cell.text)
      cells.push(
        cell.href ? `<td><a href="${escapeHtml(cell.href)}">${text}</a></td>` : `<td>${text}</td>`
      )
    }
    rows.push(`<tr>${cells.join("")}</tr>`)
  }
  return `<table>${rows.join("")}</table>`
}

const NONE_HIDDEN: ReadonlySet<number> = new Set()

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

export type MoveKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Home" | "End"

/** Where a key moves the focus cell; `jump` goes to the edge, as with Cmd or Ctrl held. */
export function moveFocus(
  point: CellPoint,
  key: MoveKey,
  bounds: { readonly rows: number; readonly columns: number },
  jump = false
): CellPoint {
  const lastRow = bounds.rows - 1
  const lastColumn = bounds.columns - 1
  switch (key) {
    case "ArrowUp":
      return { ...point, row: jump ? 0 : Math.max(0, point.row - 1) }
    case "ArrowDown":
      return { ...point, row: jump ? lastRow : Math.min(lastRow, point.row + 1) }
    case "ArrowLeft":
      return { ...point, column: jump ? 0 : Math.max(0, point.column - 1) }
    case "ArrowRight":
      return { ...point, column: jump ? lastColumn : Math.min(lastColumn, point.column + 1) }
    case "Home":
      return jump ? { row: 0, column: 0 } : { ...point, column: 0 }
    case "End":
      return jump ? { row: lastRow, column: lastColumn } : { ...point, column: lastColumn }
  }
}

export type SortDirection = "ascending" | "descending"

/** The order of the data rows sorted by one column: numbers as numbers, the rest as text. */
export function sortedOrder(
  model: SheetModel,
  sort: { readonly column: number; readonly direction: SortDirection } | null,
  locale: string
): number[] {
  const order = model.rows.map((_, index) => index)
  if (!sort) return order
  const column = model.columns[sort.column]
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" })
  const key = (index: number) => model.rows[index]?.[sort.column] ?? ""
  const sign = sort.direction === "ascending" ? 1 : -1
  return order.sort((a, b) => {
    const left = key(a)
    const right = key(b)
    // Empty cells go last whichever way the column sorts.
    if (!left.trim() || !right.trim()) return (left.trim() ? 0 : 1) - (right.trim() ? 0 : 1)
    if (column?.numeric) {
      const difference = (parseSheetNumber(left) ?? 0) - (parseSheetNumber(right) ?? 0)
      if (difference !== 0) return sign * difference
    }
    return sign * collator.compare(left, right) || a - b
  })
}

/**
 * Text from the clipboard as rows of cells, as a spreadsheet copies them: tabs between cells,
 * line breaks between rows, and a cell holding either quoted, its quotes doubled. A last empty
 * line is the copy's end, not a row.
 */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] as string
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        cell += '"'
        index += 1
      } else if (character === '"') quoted = false
      else cell += character
    } else if (character === '"' && cell === "") quoted = true
    else if (character === "\t") {
      row.push(cell)
      cell = ""
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1
      row.push(cell)
      rows.push(row)
      row = []
      cell = ""
    } else cell += character
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}
