import { useCallback, useState } from "react"
import type { SortDirection } from "./selection"

/**
 * How the reader has arranged one sheet: its sort, the columns they hid, how many columns they
 * froze, and the widths they gave columns. It lasts while the artifact is open and changes nothing
 * in it. Columns are the sheet's own, by index, so letters and addresses keep naming them.
 */
export interface SheetView {
  readonly sort: { readonly column: number; readonly direction: SortDirection } | null
  readonly hidden: readonly number[]
  /** Columns kept in view as the sheet scrolls sideways; absent, the workbook's. */
  readonly frozenColumns?: number
  /** Widths in pixels the reader gave columns; the others keep the workbook's or their fit. */
  readonly widths: Readonly<Record<number, number>>
}

export type SheetViewUpdate = (update: (view: SheetView) => SheetView) => void

export const INITIAL_SHEET_VIEW: SheetView = { sort: null, hidden: [], widths: {} }

/** One view per sheet of a workbook, so each keeps its own as the reader moves between tabs. */
export function useSheetViews(): {
  readonly viewOf: (sheet: string) => SheetView
  readonly updateOf: (sheet: string) => SheetViewUpdate
} {
  const [views, setViews] = useState<Readonly<Record<string, SheetView>>>({})
  const updateOf = useCallback(
    (sheet: string): SheetViewUpdate =>
      (update) =>
        setViews((current) => ({
          ...current,
          [sheet]: update(current[sheet] ?? INITIAL_SHEET_VIEW),
        })),
    []
  )
  return { viewOf: (sheet) => views[sheet] ?? INITIAL_SHEET_VIEW, updateOf }
}

export function hideColumn(view: SheetView, column: number): SheetView {
  if (view.hidden.includes(column)) return view
  return { ...view, hidden: [...view.hidden, column].sort((a, b) => a - b) }
}

/**
 * The nearest column the reader can see to the one a move reached, going on the way the move went
 * and turning back at the sheet's edge; the column itself when it is not hidden.
 */
export function visibleColumn(
  column: number,
  from: number,
  columnCount: number,
  hidden: ReadonlySet<number>
): number {
  if (!hidden.has(column)) return column
  const way = column >= from ? 1 : -1
  for (const step of [way, -way]) {
    for (let at = column + step; at >= 0 && at < columnCount; at += step) {
      if (!hidden.has(at)) return at
    }
  }
  return from
}
