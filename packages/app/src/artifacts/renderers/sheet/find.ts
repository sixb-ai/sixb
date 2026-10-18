import type { FormattedCell } from "./format"
import type { SheetModel } from "./model"
import type { CellPoint } from "./selection"

/** The most matches a search collects; past it, the count reads "10,000+". */
export const MAX_FIND_MATCHES = 10_000

export interface FindMatches {
  /** Cells whose value holds the query, in reading order: along each row, then down. */
  readonly points: readonly CellPoint[]
  /** Whether the search stopped at {@link MAX_FIND_MATCHES}. */
  readonly capped: boolean
}

/**
 * The data cells, as currently ordered, whose value holds the query as the grid shows it or as it
 * is stored, ignoring case and accents: `4,120` and `4120` both find 4120000, `cafe` finds Café.
 * The header row is not searched.
 */
export function findMatches(
  model: SheetModel,
  order: readonly number[],
  formatters: readonly ((value: string) => FormattedCell)[],
  query: string
): FindMatches {
  const needle = foldText(query.trim())
  const points: CellPoint[] = []
  if (!needle) return { points, capped: false }
  for (let row = 1; row <= order.length; row += 1) {
    const values = model.rows[order[row - 1] ?? -1]
    if (!values) continue
    for (let column = 0; column < model.columns.length; column += 1) {
      const value = values[column] ?? ""
      if (!value.trim()) continue
      const found =
        foldText(value).includes(needle) ||
        foldText(formatters[column]?.(value).text ?? "").includes(needle)
      if (!found) continue
      if (points.length === MAX_FIND_MATCHES) return { points, capped: true }
      points.push({ row, column })
    }
  }
  return { points, capped: false }
}

function foldText(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
}
