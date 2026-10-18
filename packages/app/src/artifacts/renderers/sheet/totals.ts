import { parseSheetNumber, type SheetTotal } from "@sixb/core/artifacts"
import type { SheetModel } from "./model"

/**
 * What the totals row shows under each column that has a total, over the rows the reader sees:
 * sorted or not, without the ones the filters hide. `count` counts values that are not empty; the
 * others read only numbers, and are undefined for a column with none.
 */
export function columnTotals(
  model: SheetModel,
  order: readonly number[]
): ReadonlyMap<number, { readonly total: SheetTotal; readonly value: number | undefined }> {
  const totals = new Map<number, { total: SheetTotal; value: number | undefined }>()
  model.columns.forEach((column, index) => {
    if (!column.total) return
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
