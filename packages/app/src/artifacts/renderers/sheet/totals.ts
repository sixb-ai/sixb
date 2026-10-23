import { parseSheetNumber, type SheetTotal } from "@sixb/core/artifacts"
import { isLocked, type SheetModel } from "./model"

/** A column's total, or `locked` when a cell it would read is one the reader may not see. */
export interface ColumnTotal {
  readonly total: SheetTotal
  readonly value: number | undefined
  readonly locked?: true
}

/**
 * What the totals row shows under each column that has a total, over the rows the reader sees:
 * sorted or not, without the ones the filters hide. `count` counts values that are not empty; the
 * others read only numbers, and are undefined for a column with none. Over a locked cell a total
 * is locked: never what it comes to without it.
 */
export function columnTotals(
  model: SheetModel,
  order: readonly number[]
): ReadonlyMap<number, ColumnTotal> {
  const totals = new Map<number, ColumnTotal>()
  model.columns.forEach((column, index) => {
    if (!column.total) return
    if (model.locked && order.some((row) => isLocked(model, row, index))) {
      totals.set(index, { total: column.total, value: undefined, locked: true })
      return
    }

    let count = 0
    let numbers = 0
    let sum = 0
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    for (const row of order) {
      const value = model.rows[row]?.[index] ?? ""
      if (!value.trim()) continue
      count += 1
      const number = parseSheetNumber(value)
      if (number === undefined) continue
      numbers += 1
      sum += number
      min = Math.min(min, number)
      max = Math.max(max, number)
    }
    const value =
      column.total === "count"
        ? count
        : numbers === 0
          ? undefined
          : { sum, average: sum / numbers, min, max }[column.total]
    totals.set(index, { total: column.total, value })
  })
  return totals
}
