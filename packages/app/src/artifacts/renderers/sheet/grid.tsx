import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  ChevronDown,
  Copy,
  Filter,
  Trash2,
} from "lucide-react"
import {
  type ClipboardEvent,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useArtifactMessages } from "../../messages"
import { CellEditor, type CommitMove } from "./cell-editor"
import {
  CellContent,
  columnTypeLabel,
  EmptyCell,
  GridCell,
  HeaderContent,
  LockedContent,
  selectionEdges,
  TotalCell,
} from "./cells"
import { CONTEXT_PARTS, type ColumnActions, ColumnMenu, ColumnMenuItems } from "./column-menu"
import type { CellEdit } from "./draft"
import { filteredOrder } from "./filter"
import { FilterPanel } from "./filter-panel"
import { findMatches } from "./find"
import { modulo, type SheetFind, type SheetFindCount } from "./find-bar"
import { elementTextMeasure, fitWidth, type TextMeasure } from "./fit"
import { cellFormatter, type FormattedCell, numberFormat } from "./format"
import { cellHighlight, highlightRanges } from "./highlight"
import type { CellInput, CellInputError } from "./input"
import { lockedCellLabel, lockedTotalLabel } from "./locked"
import { isLocked, type SheetColumn, type SheetModel } from "./model"
import {
  type CellPoint,
  type CellRange,
  cellRange,
  columnLetter,
  inRange,
  type MoveKey,
  moveFocus,
  parseTsv,
  type RangeStats,
  rangeHtml,
  rangeStats,
  rangeTsv,
  type SortDirection,
  sortedOrder,
} from "./selection"
import { columnTotals } from "./totals"
import {
  hideColumn,
  INITIAL_SHEET_VIEW,
  type SheetView,
  type SheetViewUpdate,
  setAutoFilter,
  setColumnFilter,
  visibleColumn,
} from "./view"
import { prefixOffsets, visibleRowSpan, visibleSpan } from "./virtual"

const ROW_HEIGHT = 28
const LETTER_HEIGHT = 24
/** The width of the empty columns past a sheet's data, as a spreadsheet's default column. */
const EMPTY_COLUMN_WIDTH = 96
/** A cell's padding on each side, which text that runs on keeps from the gridline. */
const CELL_PADDING = 8
const MIN_COLUMN_WIDTH = 48
const MAX_COLUMN_WIDTH = 800
const OVERSCAN_ROWS = 8
const OVERSCAN_COLUMNS = 2
/** How far an arrow key moves a column's edge from its separator. */
const RESIZE_STEP = 16

export interface SheetGridStatus {
  readonly range: CellRange
  readonly stats: RangeStats
  /** The column the active cell is in. */
  readonly column: SheetColumn | undefined
  /**
   * The active cell's whole value as it reads: a link's full address, a long text untruncated, a
   * computed cell's formula.
   */
  readonly value: string
  /** The data rows shown: every row, or those the filters keep. */
  readonly rows: number
}

/**
 * Editing a sheet in place: which columns take input, how what the reader types is read and shown,
 * and where the values go. Rows are the model's data rows, from 0.
 */
export interface SheetGridEditor {
  /** Whether a column's cells take input; a computed column's don't. */
  readonly editable: (column: number) => boolean
  /** A stored value as the reader types it back. */
  readonly inputText: (column: number, raw: string) => string
  /** What a column's cell stores from what the reader typed or pasted, or why it can't. */
  readonly read: (column: number, text: string, pasted?: boolean) => CellInput
  /**
   * Stores values, as one change. `grow` adds empty rows at the end and columns at the right
   * first, as a paste past the sheet's edge does; edits may name them. Returns why the sheet
   * can't take them, in words, when it can't.
   */
  readonly write: (
    edits: readonly CellEdit[],
    grow?: { readonly rows: number; readonly columns: number }
  ) => string | null
  /** Adds empty rows before a data row; at the row count, after the last. Returns why not. */
  readonly insertRows: (at: number, count: number) => string | null
  readonly deleteRows: (rows: readonly number[]) => void
  /** Adds an empty column before a column; at the column count, after the last. */
  readonly insertColumn: (at: number) => void
  /** Removes a column; returns why it can't be, in words, when it can't. */
  readonly deleteColumn: (column: number) => string | null
  /** Opens a column's settings: to rename it, or to set its type and form. */
  readonly editColumn: (column: number, focus: "name" | "type") => void
  readonly undo: () => void
  readonly redo: () => void
  /** Whether a cell holds a value the edit changed. */
  readonly edited: (row: number, column: number) => boolean
  /** Values to offer while typing into a column, such as its tags. */
  readonly suggestions?: (column: number) => readonly string[]
}

/**
 * A spreadsheet grid: column letters and row numbers, the header row and any frozen rows and
 * columns kept in view, a menu on each column's letter and on a right-click that sorts, filters,
 * fits, freezes, and hides it, filter buttons on the headers in filter mode, and a selection of
 * cells, rows, or columns by pointer, Shift, and keyboard that copies as TSV and as a table. Only
 * the cells in view are drawn, so a sheet of 100,000 rows scrolls like a short one. Given an
 * editor, its cells take input: typing, Enter, F2, or a double-click edits one, Delete clears the
 * selection, and Space or a click toggles a checkbox.
 */
export function SheetGrid({
  model,
  locale,
  onStatusChange,
  imageUrl,
  selected,
  find,
  onFind,
  view: viewProp,
  onViewChange,
  goTo,
  editor,
  className,
}: {
  readonly model: SheetModel
  readonly locale: string
  /** How the reader arranged the sheet; without it, the grid keeps its own. */
  readonly view?: SheetView
  readonly onViewChange?: SheetViewUpdate
  readonly onStatusChange?: (status: SheetGridStatus) => void
  /** A search: its matches are marked, and the current one is selected and brought into view. */
  readonly find?: SheetFind
  readonly onFind?: (found: SheetFindCount) => void
  /** An image cell's URL by its path in the artifact; images show only where they resolve. */
  readonly imageUrl?: (path: string) => string | undefined
  /** A range to open on, selected and in view, such as the one an address named. */
  readonly selected?: CellRange
  /** A range to go to, as the name box names one; each new `seq` goes there again. */
  readonly goTo?: { readonly range: CellRange; readonly seq: number }
  /** Edits the sheet's cells; without it, the grid is read-only. */
  readonly editor?: SheetGridEditor
  readonly className?: string
}) {
  const messages = useArtifactMessages().sheet
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const gridRef = useRef<HTMLDivElement | null>(null)
  const idPrefix = useId()
  const cellId = (row: number, column: number) => `${idPrefix}-${row}-${column}`
  const [viewport, setViewport] = useState({ top: 0, left: 0, width: 960, height: 640 })
  const [ownView, setOwnView] = useState<SheetView>(INITIAL_SHEET_VIEW)
  const view = viewProp ?? ownView
  const updateView: SheetViewUpdate = onViewChange ?? setOwnView
  const { sort } = view
  const hidden = useMemo(() => new Set(view.hidden), [view.hidden])
  // A hidden column takes no width, so the layout's offsets pass over it.
  const widths = useMemo(
    () =>
      model.columns.map((column, index) =>
        hidden.has(index) ? 0 : (view.widths[index] ?? column.width)
      ),
    [model, hidden, view.widths]
  )
  // Row 0 is the header row, as in an address; the range is kept to the cells the sheet has.
  const opening = useMemo(() => {
    if (!selected) return null
    const bottom = model.rows.length
    const right = model.columns.length - 1
    return {
      anchor: { row: Math.min(selected.top, bottom), column: Math.min(selected.left, right) },
      focus: { row: Math.min(selected.bottom, bottom), column: Math.min(selected.right, right) },
    }
  }, [selected, model])
  const [anchor, setAnchor] = useState<CellPoint>(() => opening?.anchor ?? { row: 1, column: 0 })
  const [focus, setFocus] = useState<CellPoint>(() => opening?.focus ?? { row: 1, column: 0 })
  /** What a drag selects: cells from a cell, rows from a row number, columns from a letter. */
  const dragging = useRef<"cells" | "rows" | "columns" | null>(null)
  const measure = useRef<TextMeasure | null>(null)
  /** Text widths already measured, for the cells whose text may run on over empty neighbours. */
  const textWidths = useRef(new Map<string, number>())

  const sorted = useMemo(() => sortedOrder(model, sort, locale), [model, sort, locale])
  const computedOrder = useMemo(
    () => filteredOrder(model, sorted, view.filters, locale),
    [model, sorted, view.filters, locale]
  )
  // While the sheet is edited, rows keep their places as their values change, as a spreadsheet's
  // do: the sort and filters apply again when they change, or when rows come or go.
  const held = useRef<HeldOrder | null>(null)
  let order = computedOrder
  if (editor) {
    const last = held.current
    if (
      last &&
      last.sort === sort &&
      last.filters === view.filters &&
      last.locale === locale &&
      last.rows === model.rows.length
    ) {
      order = last.order
    } else {
      held.current = {
        sort,
        filters: view.filters,
        locale,
        rows: model.rows.length,
        order: computedOrder,
      }
    }
  } else held.current = null
  /** The cell being typed into: what's typed so far, and why it can't be stored when it can't. */
  const [editing, setEditing] = useState<{
    readonly point: CellPoint
    readonly text: string
    readonly error?: CellInputError
    /** A value the sheet's rules refuse, such as a chart's: the rule, in words. */
    readonly refused?: string
  } | null>(null)
  const typedText = editing?.text
  const typedAt = editing?.point
  /** A word on what the last paste left out, shown for a moment over the grid. */
  const [notice, setNotice] = useState<string | null>(null)
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])
  /** Says why the sheet refused a change, when it did. */
  const refuse = (why: string | null) => {
    if (why) setNotice(why)
  }
  /** The column whose filter is open. */
  const [filtering, setFiltering] = useState<number | null>(null)
  /** What the reader right-clicked, which decides what the context menu offers. */
  const [contextTarget, setContextTarget] = useState<ContextTarget>(null)
  /** Whether the context menu's Filter item closed it, so focus stays with the filter. */
  const contextFiltering = useRef(false)
  const formatters = useMemo(
    () => model.columns.map((column) => cellFormatter(column, locale)),
    [model, locale]
  )
  const rowCount = order.length + 1
  const columnCount = model.columns.length
  const highlights = useMemo(() => highlightRanges(model), [model])
  // Totals follow what the reader sees: the filters change them, the sort does not.
  const totals = useMemo(() => (model.totals ? columnTotals(model, order) : null), [model, order])
  const range = useMemo(() => cellRange(anchor, focus), [anchor, focus])

  const findQuery = find?.query ?? ""
  const findIndex = find?.index ?? 0
  const matches = useMemo(
    () => findMatches(model, order, formatters, findQuery, hidden),
    [model, order, formatters, findQuery, hidden]
  )
  const matched = useMemo(
    () => new Set(matches.points.map((point) => `${point.row}:${point.column}`)),
    [matches]
  )

  // Layout, in content pixels.
  const rowNumberWidth = Math.max(44, String(rowCount).length * 8 + 24)
  const offsets = useMemo(() => prefixOffsets(widths), [widths])
  const frozenColumns = Math.min(view.frozenColumns ?? model.frozenColumns, columnCount)
  const frozenRows = Math.min(model.frozenRows, rowCount)
  const frozenWidth = offsets[frozenColumns] ?? 0
  const totalWidth = rowNumberWidth + (offsets.at(-1) ?? 0)
  const headerHeight = LETTER_HEIGHT + frozenRows * ROW_HEIGHT
  const footerHeight = totals ? ROW_HEIGHT : 0
  const bodyRows = rowCount - frozenRows

  const columns = visibleSpan(
    offsets,
    viewport.left + frozenWidth,
    viewport.left + viewport.width - rowNumberWidth,
    OVERSCAN_COLUMNS
  )
  const firstColumn = Math.max(columns.first, frozenColumns)
  const scrollingColumns: number[] = []
  for (let column = firstColumn; column <= columns.last; column += 1) {
    if (!hidden.has(column)) scrollingColumns.push(column)
  }
  const fixedColumns = Array.from({ length: frozenColumns }, (_, index) => index).filter(
    (column) => !hidden.has(column)
  )
  const leadingSpace = (offsets[firstColumn] ?? 0) - frozenWidth
  const rows = visibleRowSpan(
    ROW_HEIGHT,
    bodyRows,
    viewport.top,
    viewport.top + viewport.height - headerHeight,
    OVERSCAN_ROWS
  )
  // Past the sheet's data, empty columns and rows fill the view, as a spreadsheet's grid runs on.
  const viewWidth = Math.max(totalWidth, viewport.width)
  const emptyColumns = Math.ceil((viewWidth - totalWidth) / EMPTY_COLUMN_WIDTH)
  const contentHeight = headerHeight + bodyRows * ROW_HEIGHT + footerHeight
  const viewHeight = Math.max(contentHeight, viewport.height)
  const emptyRows = Math.ceil((viewHeight - contentHeight) / ROW_HEIGHT)

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const measure = () =>
      setViewport({
        top: element.scrollTop,
        left: element.scrollLeft,
        width: element.clientWidth,
        height: element.clientHeight,
      })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    let frame = 0
    const onScroll = () => {
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0
          measure()
        })
      }
    }
    element.addEventListener("scroll", onScroll, { passive: true })
    return () => {
      observer.disconnect()
      element.removeEventListener("scroll", onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [])

  useEffect(() => {
    const raw =
      focus.row === 0
        ? (model.columns[focus.column]?.name ?? "")
        : (model.rows[order[focus.row - 1] ?? -1]?.[focus.column] ?? "")
    const cell = focus.row === 0 ? null : formatters[focus.column]?.(raw)
    // A computed cell shows its formula, as a spreadsheet's formula bar does; a cell being typed
    // into, what's typed.
    const formula = focus.row === 0 ? undefined : model.columns[focus.column]?.format.formula
    const typed =
      typedText !== undefined && typedAt?.row === focus.row && typedAt.column === focus.column
        ? typedText
        : undefined
    onStatusChange?.({
      range,
      stats: rangeStats(range, model, order, hidden),
      column: model.columns[focus.column],
      value:
        typed ??
        (formula
          ? `=${formula}`
          : cell
            ? (cell.href ?? cell.reference ?? cell.image ?? cell.text)
            : raw),
      rows: order.length,
    })
  }, [
    onStatusChange,
    range,
    model,
    order,
    formatters,
    hidden,
    focus.row,
    focus.column,
    typedText,
    typedAt,
  ])

  // A filter that keeps fewer rows pulls the selection up into the rows still shown.
  useEffect(() => {
    const last = rowCount - 1
    setAnchor((current) => (current.row > last ? { ...current, row: last } : current))
    setFocus((current) => (current.row > last ? { ...current, row: last } : current))
  }, [rowCount])

  useEffect(() => {
    const stop = () => {
      dragging.current = null
    }
    window.addEventListener("pointerup", stop)
    return () => window.removeEventListener("pointerup", stop)
  }, [])

  /** Scrolls so the cell is in view, clear of the frozen header and columns. */
  const reveal = useCallback(
    (point: CellPoint) => {
      const element = scrollRef.current
      if (!element) return
      if (point.row >= frozenRows) {
        const top = headerHeight + (point.row - frozenRows) * ROW_HEIGHT
        if (top < element.scrollTop + headerHeight) element.scrollTop = top - headerHeight
        // The totals row covers the bottom of the view.
        else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight - footerHeight) {
          element.scrollTop = top + ROW_HEIGHT - element.clientHeight + footerHeight
        }
      }
      if (point.column >= frozenColumns) {
        const left = rowNumberWidth + (offsets[point.column] ?? 0)
        const right = rowNumberWidth + (offsets[point.column + 1] ?? 0)
        const visibleFrom = element.scrollLeft + rowNumberWidth + frozenWidth
        if (left < visibleFrom) element.scrollLeft = left - rowNumberWidth - frozenWidth
        else if (right > element.scrollLeft + element.clientWidth) {
          element.scrollLeft = right - element.clientWidth
        }
      }
    },
    [frozenRows, frozenColumns, headerHeight, footerHeight, rowNumberWidth, offsets, frozenWidth]
  )

  useEffect(() => {
    onFind?.({ count: matches.points.length, capped: matches.capped })
  }, [onFind, matches])

  // The current match becomes the selection, in view. Only a new query, a step, or a new order
  // moves it: resizing a column or scrolling leaves the reader's own selection be.
  const revealMatch = useRef(reveal)
  revealMatch.current = reveal
  useEffect(() => {
    const count = matches.points.length
    const point = count > 0 ? matches.points[modulo(findIndex, count)] : undefined
    if (!point) return
    setAnchor(point)
    setFocus(point)
    revealMatch.current(point)
  }, [matches, findIndex])

  // The name box's range, kept to the cells shown, becomes the selection, in view, with focus.
  const revealGoTo = useRef(reveal)
  revealGoTo.current = reveal
  const goToSeq = goTo?.seq
  const goToRange = useRef(goTo?.range)
  goToRange.current = goTo?.range
  useEffect(() => {
    const target = goToRange.current
    if (goToSeq === undefined || !target) return
    const point = (row: number, column: number) => ({
      row: Math.min(row, rowCount - 1),
      column: Math.min(column, columnCount - 1),
    })
    const start = point(target.top, target.left)
    const end = point(target.bottom, target.right)
    setAnchor(start)
    setFocus(end)
    revealGoTo.current(end)
    revealGoTo.current(start)
    gridRef.current?.focus({ preventScroll: true })
  }, [goToSeq, rowCount, columnCount])

  const revealedOpening = useRef(false)
  useLayoutEffect(() => {
    if (!opening || revealedOpening.current) return
    revealedOpening.current = true
    reveal(opening.focus)
    reveal(opening.anchor)
  }, [opening, reveal])

  const select = (point: CellPoint, extend: boolean) => {
    if (!extend) setAnchor(point)
    setFocus(point)
  }

  /** A cell takes input when the grid edits, it holds data, and its column isn't computed. */
  const editableAt = (point: CellPoint) =>
    !!editor && point.row > 0 && point.column >= 0 && editor.editable(point.column)

  /** Opens a cell's editor with its value, or with what the reader started typing. */
  const startEdit = (point: CellPoint, typed?: string): boolean => {
    if (!editor || !editableAt(point)) return false
    setEditing({
      point,
      text: typed ?? editor.inputText(point.column, valueAt(point.row, point.column)),
    })
    reveal(point)
    return true
  }

  const endEdit = () => {
    setEditing(null)
    gridRef.current?.focus({ preventScroll: true })
  }

  /** Stores what was typed and moves on; holds it, with why, when it doesn't fit the column. */
  const commitEdit = (move: CommitMove | null): boolean => {
    if (!editing || !editor) return true
    const { point, text } = editing
    const result = editor.read(point.column, text)
    if ("error" in result) {
      setEditing({ ...editing, error: result.error })
      return false
    }
    const row = order[point.row - 1]
    const refused =
      row === undefined ? null : editor.write([{ row, column: point.column, value: result.value }])
    if (refused) {
      setEditing({ point, text, refused })
      return false
    }

    endEdit()
    if (move) {
      const next =
        move === "down"
          ? { ...point, row: Math.min(rowCount - 1, point.row + 1) }
          : move === "up"
            ? { ...point, row: Math.max(1, point.row - 1) }
            : {
                ...point,
                column: visibleColumn(
                  Math.min(
                    columnCount - 1,
                    Math.max(0, point.column + (move === "right" ? 1 : -1))
                  ),
                  point.column,
                  columnCount,
                  hidden
                ),
              }
      select(next, false)
      reveal(next)
    }
    return true
  }

  /** The selection's cells that take input, by data row. */
  const editableCells = (): { row: number; column: number }[] => {
    const cells: { row: number; column: number }[] = []
    for (let row = Math.max(1, range.top); row <= range.bottom; row += 1) {
      const dataRow = order[row - 1]
      if (dataRow === undefined) continue
      for (let column = range.left; column <= range.right; column += 1) {
        if (!hidden.has(column) && editableAt({ row, column })) cells.push({ row: dataRow, column })
      }
    }
    return cells
  }

  /** Delete clears the selection's cells. */
  const clearSelection = () => {
    if (!editor) return
    refuse(editor.write(editableCells().map((cell) => ({ ...cell, value: "" }))))
  }

  /**
   * Space, or a click on a checkbox, toggles the selection's checkboxes: all on unless they all
   * are, as a spreadsheet's do.
   */
  const toggleChecks = (cells: readonly { row: number; column: number }[]) => {
    if (!editor) return
    const checks = cells.filter((cell) => model.columns[cell.column]?.format.type === "boolean")
    if (checks.length === 0) return
    const allOn = checks.every(
      (cell) => (model.rows[cell.row]?.[cell.column] ?? "").trim().toLowerCase() === "true"
    )
    refuse(editor.write(checks.map((cell) => ({ ...cell, value: allOn ? "false" : "true" }))))
  }

  /** The data rows of the selection's rows, in the order they're shown. */
  const selectedRows = (): number[] => {
    const rows: number[] = []
    for (let row = Math.max(1, range.top); row <= range.bottom; row += 1) {
      const dataRow = order[row - 1]
      if (dataRow !== undefined) rows.push(dataRow)
    }
    return rows
  }

  /** Empty rows above or below the selection's, as many as it spans. */
  const insertRowsBeside = (where: "above" | "below") => {
    if (!editor) return
    const rows = selectedRows()
    const first = order[Math.max(1, range.top) - 1]
    const last = order[range.bottom - 1]
    const at = where === "above" ? first : last === undefined ? undefined : last + 1
    refuse(editor.insertRows(at ?? model.rows.length, Math.max(1, rows.length)))
  }

  const deleteSelectedRows = () => {
    if (!editor) return
    const rows = selectedRows()
    if (rows.length === 0) return
    editor.deleteRows(rows)
    const top = Math.max(1, Math.min(range.top, rowCount - 1 - rows.length))
    select({ row: top, column: focus.column }, false)
  }

  /** ⌘D: the selection's first row copied down through the rest of it, as a spreadsheet fills. */
  const fillDown = () => {
    if (!editor || range.bottom <= Math.max(1, range.top)) return
    const top = Math.max(1, range.top)
    const source = order[top - 1]
    if (source === undefined) return
    const edits: CellEdit[] = []
    for (let row = top + 1; row <= range.bottom; row += 1) {
      const dataRow = order[row - 1]
      if (dataRow === undefined) continue
      for (let column = range.left; column <= range.right; column += 1) {
        if (hidden.has(column) || !editableAt({ row, column })) continue
        edits.push({ row: dataRow, column, value: model.rows[source]?.[column] ?? "" })
      }
    }
    refuse(editor.write(edits))
  }

  /**
   * A block from the clipboard, written from the selection's top left as one change: past the
   * last row or column, the sheet grows to hold it; one value fills the whole selection. A value
   * that doesn't fit its column, or lands in a computed one, is left out and counted.
   */
  const paste = (block: readonly (readonly string[])[]) => {
    if (!editor || block.length === 0) return
    const top = Math.max(1, range.top)
    const single = block.length === 1 && block[0]?.length === 1
    const height = single ? range.bottom - top + 1 : block.length
    const width = single
      ? range.right - range.left + 1
      : Math.max(...block.map((row) => row.length))
    const shown = order.length
    const extraRows = Math.max(0, top - 1 + height - shown)
    const extraColumns = Math.max(0, range.left + width - columnCount)
    const edits: CellEdit[] = []
    let skipped = 0
    for (let offset = 0; offset < height; offset += 1) {
      const row = top + offset
      // Rows past those shown are the ones the paste adds, after the table's last.
      const dataRow = row <= shown ? order[row - 1] : model.rows.length + (row - shown - 1)
      if (dataRow === undefined) continue
      for (let across = 0; across < width; across += 1) {
        const column = range.left + across
        const text = single ? (block[0]?.[0] ?? "") : (block[offset]?.[across] ?? "")
        if (column >= columnCount) {
          edits.push({ row: dataRow, column, value: text })
          continue
        }
        if (hidden.has(column) || !editor.editable(column)) {
          if (text.trim()) skipped += 1
          continue
        }
        const read = editor.read(column, text, true)
        if ("error" in read) skipped += 1
        else edits.push({ row: dataRow, column, value: read.value })
      }
    }
    const refused = editor.write(edits, { rows: extraRows, columns: extraColumns })
    if (refused) {
      setNotice(refused)
      return
    }

    setAnchor({ row: top, column: range.left })
    setFocus({ row: top + height - 1, column: range.left + width - 1 })
    setNotice(skipped > 0 ? messages.pasteSkipped(skipped) : null)
  }

  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    if (!editor || editing || event.target !== event.currentTarget) return
    const text = event.clipboardData.getData("text/plain")
    if (!text) return
    event.preventDefault()
    paste(parseTsv(text))
  }

  /** Every cell of the rows from one to another, header row included when it is one of them. */
  const selectRows = (from: number, to: number) => {
    setAnchor({ row: from, column: 0 })
    setFocus({ row: to, column: columnCount - 1 })
  }

  const selectColumns = (from: number, to: number) => {
    setAnchor({ row: 0, column: from })
    setFocus({ row: rowCount - 1, column: to })
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-cell]")
    if (!target || (event.target as HTMLElement).closest("a, button, input")) return
    const point = cellPoint(target)
    if (!point) return
    event.preventDefault()
    gridRef.current?.focus({ preventScroll: true })
    // A click on a checkbox toggles it while the sheet is edited.
    if (
      editor &&
      !event.shiftKey &&
      (event.target as HTMLElement).closest("[data-check]") &&
      editableAt(point)
    ) {
      const row = order[point.row - 1]
      select(point, false)
      if (row !== undefined) toggleChecks([{ row, column: point.column }])
      return
    }
    if (point.column < 0) {
      // A row number selects its row; with Shift, every row from the selection's.
      dragging.current = "rows"
      selectRows(event.shiftKey ? anchor.row : point.row, point.row)
      return
    }
    if (point.row < 0) {
      // A column letter selects its column; with Shift, every column from the selection's.
      dragging.current = "columns"
      selectColumns(event.shiftKey ? anchor.column : point.column, point.column)
      return
    }
    dragging.current = "cells"
    select(point, event.shiftKey)
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const mode = dragging.current
    if (!mode) return
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-cell]")
    const point = target ? cellPoint(target) : null
    if (!point) return
    if (mode === "rows") {
      if (point.row >= 0 && point.row !== focus.row) {
        setFocus({ row: point.row, column: columnCount - 1 })
      }
    } else if (mode === "columns") {
      if (point.column >= 0 && point.column !== focus.column) {
        setFocus({ row: rowCount - 1, column: point.column })
      }
    } else if (point.row >= 0 && point.column >= 0) {
      if (point.row !== focus.row || point.column !== focus.column) setFocus(point)
    }
  }

  /** The selection on the clipboard as TSV, and as a table where the browser takes HTML. */
  const copy = async () => {
    const text = rangeTsv(range, model, order, hidden)
    try {
      if (typeof ClipboardItem !== "function" || !navigator.clipboard.write) {
        throw new Error("No rich clipboard.")
      }
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([text], { type: "text/plain" }),
          "text/html": new Blob([rangeHtml(range, model, order, formatters, hidden)], {
            type: "text/html",
          }),
        }),
      ])
    } catch {
      try {
        await navigator.clipboard.writeText(text)
      } catch {
        // The clipboard can be unavailable, such as on an insecure origin.
      }
    }
  }

  const onKeyDown = async (event: KeyboardEvent<HTMLDivElement>) => {
    // Keys pressed on a control inside the grid, such as a column's menu, are that control's.
    if (event.target !== event.currentTarget) return
    const command = event.metaKey || event.ctrlKey
    if (command && event.key.toLowerCase() === "a") {
      event.preventDefault()
      setAnchor({ row: 0, column: 0 })
      setFocus({ row: rowCount - 1, column: columnCount - 1 })
      return
    }
    if (command && event.key.toLowerCase() === "c") {
      event.preventDefault()
      await copy()
      return
    }
    if (editor && command && !event.altKey) {
      const key = event.key.toLowerCase()
      if (key === "z" || key === "y") {
        event.preventDefault()
        if (key === "y" || event.shiftKey) editor.redo()
        else editor.undo()
        return
      }
      if (key === "d") {
        event.preventDefault()
        fillDown()
        return
      }
    }
    // Shift+Space selects the selection's rows, Ctrl+Space its columns, and both every cell.
    if (event.key === " " && (event.shiftKey || event.ctrlKey) && !event.metaKey) {
      event.preventDefault()
      if (event.shiftKey && event.ctrlKey) selectRows(0, rowCount - 1)
      else if (event.shiftKey) selectRows(anchor.row, focus.row)
      else selectColumns(anchor.column, focus.column)
      return
    }
    if (event.key === "Escape") {
      setAnchor(focus)
      return
    }
    if (editor && !command && !event.altKey) {
      if (event.key === "Enter" || event.key === "F2") {
        if (startEdit(focus)) event.preventDefault()
        return
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault()
        clearSelection()
        return
      }
      if (event.key === " " && !event.shiftKey) {
        event.preventDefault()
        toggleChecks(editableCells())
        return
      }
      // A character typed on a cell starts its value afresh, as a spreadsheet's does.
      if (event.key.length === 1 && !event.nativeEvent.isComposing) {
        if (startEdit(focus, event.key)) event.preventDefault()
        return
      }
    }
    const page = Math.max(
      1,
      Math.floor((viewport.height - headerHeight - footerHeight) / ROW_HEIGHT) - 1
    )
    let next: CellPoint | null = null
    if (event.key === "PageDown") next = { ...focus, row: Math.min(rowCount - 1, focus.row + page) }
    else if (event.key === "PageUp") next = { ...focus, row: Math.max(0, focus.row - page) }
    else if (MOVE_KEYS.has(event.key)) {
      next = moveFocus(
        focus,
        event.key as MoveKey,
        { rows: rowCount, columns: columnCount },
        command
      )
    }
    if (!next) return
    event.preventDefault()
    next = { ...next, column: visibleColumn(next.column, focus.column, columnCount, hidden) }
    select(next, event.shiftKey)
    reveal(next)
  }

  const setWidth = (column: number, width: number) => {
    const clamped = Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, width))
    updateView((current) => ({ ...current, widths: { ...current.widths, [column]: clamped } }))
  }

  /** Back to the width the column opened at: the workbook's, or one that fits its values. */
  const resetWidth = (column: number) =>
    updateView((current) => {
      const { [column]: _, ...widths } = current.widths
      return { ...current, widths }
    })

  const resize = (column: number, event: PointerEvent<HTMLSpanElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const startWidth = widths[column] ?? 0
    const move = (moveEvent: globalThis.PointerEvent) => {
      setWidth(column, startWidth + moveEvent.clientX - startX)
    }
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  /** The width that shows the column's name and widest value whole. */
  const fit = (column: number): number => {
    const format = formatters[column]
    const entry = model.columns[column]
    if (!entry || !format) return widths[column] ?? MIN_COLUMN_WIDTH
    measure.current ??= elementTextMeasure(gridRef.current)
    return fitWidth(entry, column, model.rows, format, measure.current)
  }

  /** The arrows widen and narrow a column from its separator; Enter puts back its first width. */
  const resizeWithKey = (column: number, event: KeyboardEvent<HTMLSpanElement>) => {
    const width = widths[column] ?? 0
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      setWidth(column, width + (event.key === "ArrowRight" ? RESIZE_STEP : -RESIZE_STEP))
    } else if (event.key === "Enter") {
      resetWidth(column)
    } else return
    event.preventDefault()
  }

  const sortBy = (column: number, direction: SortDirection | null) =>
    updateView((current) => ({ ...current, sort: direction ? { column, direction } : null }))

  /** Whether freezing up to a column leaves most of the grid's width to scroll. */
  const canFreeze = (column: number) =>
    rowNumberWidth + (offsets[column + 1] ?? 0) <= viewport.width * FROZEN_SHARE

  /** Filter mode on, the header in view, and the column's filter open. */
  const openFilter = (column: number) => {
    updateView((current) => setAutoFilter(current, true))
    reveal({ row: 0, column })
    setFiltering(column)
  }

  const hide = (column: number) => {
    updateView((current) => hideColumn(current, column))
    // The active cell leaves the column it was in for the nearest one still shown.
    const shown = new Set([...hidden, column])
    const next = { ...focus, column: visibleColumn(column, column - 1, columnCount, shown) }
    if (focus.column === column) select(next, false)
  }

  const columnActions = (column: number): ColumnActions => ({
    sort: sort?.column === column ? sort.direction : null,
    onSort: (direction) => sortBy(column, direction),
    onFilter: () => openFilter(column),
    onFit: () => setWidth(column, fit(column)),
    frozen: column < frozenColumns,
    ...(canFreeze(column)
      ? { onFreeze: () => updateView((current) => ({ ...current, frozenColumns: column + 1 })) }
      : {}),
    ...(frozenColumns > 0
      ? { onUnfreeze: () => updateView((current) => ({ ...current, frozenColumns: 0 })) }
      : {}),
    ...(hidden.size < columnCount - 1 ? { onHide: () => hide(column) } : {}),
    ...(editor
      ? {
          edit: {
            onInsertLeft: () => editor.insertColumn(column),
            onInsertRight: () => editor.insertColumn(column + 1),
            onRename: () => editor.editColumn(column, "name"),
            onSettings: () => editor.editColumn(column, "type"),
            onDelete: () => {
              const refused = editor.deleteColumn(column)
              if (refused) setNotice(refused)
              else
                select(
                  { row: focus.row, column: Math.max(0, Math.min(column, columnCount - 2)) },
                  false
                )
            },
          },
        }
      : {}),
  })

  /**
   * A right-click names what the menu is for, and selects it first when it is outside the
   * selection, as a spreadsheet does: a column from its letter, a row from its number, or a cell.
   */
  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-cell]")
    const point = target ? cellPoint(target) : null
    if (!point) {
      setContextTarget(null)
      return
    }
    gridRef.current?.focus({ preventScroll: true })
    if (point.row < 0) {
      setContextTarget({ kind: "column", column: point.column })
      const whole = range.top === 0 && range.bottom === rowCount - 1
      if (!whole || point.column < range.left || point.column > range.right) {
        selectColumns(point.column, point.column)
      }
    } else if (point.column < 0) {
      setContextTarget({ kind: "row" })
      if (point.row < range.top || point.row > range.bottom) selectRows(point.row, point.row)
    } else {
      setContextTarget({ kind: "column", column: point.column, cell: true })
      if (!inRange(range, point.row, point.column)) select(point, false)
    }
  }

  const valueAt = (row: number, column: number): string =>
    row === 0
      ? (model.columns[column]?.name ?? "")
      : (model.rows[order[row - 1] ?? -1]?.[column] ?? "")

  const textWidth = (text: string): number => {
    if (!measure.current && gridRef.current) measure.current = elementTextMeasure(gridRef.current)
    const known = textWidths.current.get(text)
    if (known !== undefined) return known
    const width = measure.current ? measure.current(text, false) : text.length * 7.4
    if (textWidths.current.size > 5_000) textWidths.current.clear()
    textWidths.current.set(text, width)
    return width
  }

  /**
   * Which cells of a row's run of columns carry text over empty cells to their right, as a
   * spreadsheet lets text run on: only plain text wider than its cell, only over cells with no
   * value, and, at the end of the data, over the empty columns that fill the view.
   */
  const runOn = (row: number, segment: readonly number[], trailing: number) => {
    const spills = new Map<number, number>()
    const covered = new Map<number, "through" | "end">()
    for (let index = 0; index < segment.length; index += 1) {
      const column = segment[index] as number
      const cell = cellAt(row, column)
      if (!cell || model.columns[column]?.numeric || cell.number) continue
      if (
        cell.href ||
        cell.reference ||
        cell.image ||
        cell.tag ||
        cell.error ||
        cell.check !== undefined
      )
        continue
      if (!cell.text.trim()) continue
      const need = textWidth(cell.text) + CELL_PADDING * 2
      let width = widths[column] ?? 0
      if (need <= width) continue
      const over: number[] = []
      let next = index + 1
      while (width < need && next < segment.length) {
        const neighbour = segment[next] as number
        if (valueAt(row, neighbour).trim() || lockedAt(row, neighbour)) break
        over.push(neighbour)
        width += widths[neighbour] ?? 0
        next += 1
      }
      // Past the last column of the data, the empty columns that fill the view.
      if (width < need && next === segment.length) {
        for (let empty = 0; empty < trailing && width < need; empty += 1) {
          over.push(columnCount + empty)
          width += EMPTY_COLUMN_WIDTH
        }
      }
      if (over.length === 0) continue
      spills.set(column, Math.min(width, need))
      over.forEach((neighbour, at) => {
        covered.set(neighbour, at === over.length - 1 ? "end" : "through")
      })
      index = next - 1
    }
    return { spills, covered }
  }

  const cellAt = (row: number, column: number): FormattedCell | undefined =>
    row === 0 ? undefined : formatters[column]?.(valueAt(row, column))

  /** Whether a grid row's cell holds a value the reader may not see. */
  const lockedAt = (row: number, column: number): boolean =>
    row > 0 && isLocked(model, order[row - 1] ?? -1, column)

  /** One grid row: its number, the frozen cells, then the cells in view. */
  const renderRow = (row: number) => {
    const header = row === 0
    const rowSelected = row >= range.top && row <= range.bottom
    const frozenRun = header ? null : runOn(row, fixedColumns, 0)
    const scrollingRun = header ? null : runOn(row, scrollingColumns, emptyColumns)
    const cell = (column: number, fixed: boolean) => {
      const run = fixed ? frozenRun : scrollingRun
      const spill = run?.spills.get(column)
      const covered = run?.covered.get(column)
      const width = widths[column] ?? 0
      const shading = highlights.get(column)
      const highlight =
        header || !shading ? undefined : cellHighlight(shading, valueAt(row, column))
      const style: CSSProperties = {
        width,
        ...(fixed ? { left: rowNumberWidth + (offsets[column] ?? 0) } : {}),
        ...selectionEdges(range, row, column),
      }
      const typing =
        editing && editing.point.row === row && editing.point.column === column ? editing : null
      const dataRow = header ? undefined : order[row - 1]
      return (
        <GridCell
          key={column}
          id={cellId(row, column)}
          row={row}
          column={column}
          header={header}
          fixed={fixed}
          lastFixed={fixed && column === frozenColumns - 1}
          scrolled={viewport.left > 0}
          selected={inRange(range, row, column)}
          active={row === focus.row && column === focus.column}
          corner={row === range.bottom && column === range.right}
          {...(spill === undefined ? {} : { spill })}
          {...(covered ? { covered } : {})}
          sort={header && sort?.column === column ? sort.direction : undefined}
          {...(header && model.columns[column]
            ? headerTitle(model.columns[column] as SheetColumn)
            : {})}
          matched={matched.has(`${row}:${column}`)}
          {...(highlight ? { highlight } : {})}
          edited={!!editor && dataRow !== undefined && editor.edited(dataRow, column)}
          editing={!!typing}
          style={style}
        >
          {typing && editor ? (
            <CellEditor
              text={typing.text}
              {...(typing.error
                ? { error: messages.inputErrors[typing.error] }
                : typing.refused
                  ? { error: typing.refused }
                  : {})}
              numeric={model.columns[column]?.numeric ?? false}
              label={messages.editCell(`${columnLetter(column)}${row + 1}`)}
              {...(editor.suggestions ? { suggestions: editor.suggestions(column) } : {})}
              onChange={(text) =>
                setEditing((current) => (current ? { point: current.point, text } : current))
              }
              onCommit={commitEdit}
              onCancel={endEdit}
            />
          ) : header ? (
            <HeaderContent
              column={model.columns[column]}
              sort={sort?.column === column ? sort.direction : null}
              filterButton={
                view.autoFilter ? (
                  <FilterButton
                    name={model.columns[column]?.name ?? ""}
                    filtered={!!view.filters[column]}
                    sort={sort?.column === column ? sort.direction : null}
                    open={filtering === column}
                    onOpenChange={(open) => setFiltering(open ? column : null)}
                  >
                    <FilterPanel
                      model={model}
                      column={column}
                      format={formatters[column] ?? ((value) => ({ text: value }))}
                      filter={view.filters[column]}
                      onChange={(filter) =>
                        updateView((current) => setColumnFilter(current, column, filter))
                      }
                      sort={sort?.column === column ? sort.direction : null}
                      onSort={(direction) => sortBy(column, direction)}
                    />
                  </FilterButton>
                ) : undefined
              }
            />
          ) : lockedAt(row, column) ? (
            <LockedContent
              label={lockedCellLabel(model, order[row - 1] ?? -1, column, messages)}
              numeric={model.columns[column]?.numeric ?? false}
            />
          ) : (
            <CellContent
              cell={cellAt(row, column) ?? { text: "" }}
              numeric={model.columns[column]?.numeric ?? false}
              {...(spill === undefined ? {} : { spill })}
              imageUrl={imageUrl}
            />
          )}
        </GridCell>
      )
    }
    return (
      <div
        key={row}
        role="row"
        aria-rowindex={row + 1}
        className="flex overflow-clip"
        style={{ width: viewWidth, height: ROW_HEIGHT }}
      >
        <div
          data-cell=""
          data-row={row}
          data-column={-1}
          className={cn(
            "sticky left-0 z-[2] flex shrink-0 items-center justify-center border-r border-b border-border text-[11px] tabular-nums select-none",
            rowSelected ? SELECTED_ROW_NUMBER : GUTTER
          )}
          style={{ width: rowNumberWidth }}
          role="rowheader"
          aria-colindex={1}
        >
          {row + 1}
        </div>
        {fixedColumns.map((column) => cell(column, true))}
        {leadingSpace > 0 ? <div className="shrink-0" style={{ width: leadingSpace }} /> : null}
        {scrollingColumns.map((column) => cell(column, false))}
        {Array.from({ length: emptyColumns }, (_, index) => (
          <EmptyCell
            key={`empty-${index}`}
            width={EMPTY_COLUMN_WIDTH}
            {...(scrollingRun?.covered.get(columnCount + index) === "through"
              ? { through: true }
              : {})}
          />
        ))}
      </div>
    )
  }

  /** A header's hover text: its name and type, its formula, and what it means. */
  const headerTitle = (column: SheetColumn) => ({
    title: [
      `${column.name} · ${columnTypeLabel(column, messages)}`,
      column.format.formula ? `=${column.format.formula}` : undefined,
      column.description,
    ]
      .filter(Boolean)
      .join("\n"),
    ...(column.description ? { description: column.description } : {}),
  })

  /**
   * The totals row, pinned under the rows in view and right after the last one: each total in its
   * column's format, a count as a whole number, and "Total" in the first column without one.
   */
  const totalsRow = () => {
    if (!totals) return null
    const labelColumn = model.columns.findIndex(
      (column, index) => !hidden.has(index) && !column.total
    )
    const count = numberFormat(locale, { maximumFractionDigits: 0 })
    const cell = (column: number, fixed: boolean) => {
      const entry = totals.get(column)
      const value = entry?.value
      const text =
        entry && value !== undefined
          ? entry.total === "count"
            ? count.format(value)
            : (formatters[column]?.(String(value)).text ?? "")
          : column === labelColumn
            ? messages.total
            : ""
      return (
        <TotalCell
          key={column}
          text={text}
          label={!entry}
          {...(entry ? { title: messages[entry.total] } : {})}
          {...(entry?.locked ? { locked: lockedTotalLabel(model, column, messages) } : {})}
          fixed={fixed}
          lastFixed={fixed && column === frozenColumns - 1}
          scrolled={viewport.left > 0}
          style={{
            width: widths[column] ?? 0,
            ...(fixed ? { left: rowNumberWidth + (offsets[column] ?? 0) } : {}),
          }}
        />
      )
    }
    return (
      <div
        role="row"
        aria-label={messages.totals}
        aria-rowindex={rowCount + 1}
        className="sticky bottom-0 z-[3] flex overflow-clip shadow-[0_-1px_0_var(--border)]"
        style={{ width: viewWidth, height: ROW_HEIGHT }}
      >
        <div
          role="rowheader"
          aria-hidden="true"
          className={cn(
            "sticky left-0 z-[2] flex shrink-0 items-center justify-center border-r border-border text-[12px] select-none",
            GUTTER
          )}
          style={{ width: rowNumberWidth }}
        >
          Σ
        </div>
        {fixedColumns.map((column) => cell(column, true))}
        {leadingSpace > 0 ? (
          <div className="shrink-0 bg-(--sheet-header)" style={{ width: leadingSpace }} />
        ) : null}
        {scrollingColumns.map((column) => cell(column, false))}
        {emptyColumns > 0 ? (
          <div
            className="shrink-0 bg-(--sheet-header)"
            style={{ width: emptyColumns * EMPTY_COLUMN_WIDTH }}
          />
        ) : null}
      </div>
    )
  }

  /** A row past the sheet's data: its number, and empty cells under the columns in view. */
  const emptyRow = (row: number) => (
    <div key={row} className="flex overflow-clip" style={{ width: viewWidth, height: ROW_HEIGHT }}>
      <div
        className={cn(
          "sticky left-0 z-[2] flex shrink-0 items-center justify-center border-r border-b border-border text-[11px] text-muted-foreground/70 tabular-nums select-none",
          GUTTER
        )}
        style={{ width: rowNumberWidth }}
      >
        {row + 1}
      </div>
      {fixedColumns.map((column) => (
        <EmptyCell
          key={column}
          width={widths[column] ?? 0}
          fixed
          left={rowNumberWidth + (offsets[column] ?? 0)}
        />
      ))}
      {leadingSpace > 0 ? <div className="shrink-0" style={{ width: leadingSpace }} /> : null}
      {scrollingColumns.map((column) => (
        <EmptyCell key={column} width={widths[column] ?? 0} />
      ))}
      {Array.from({ length: emptyColumns }, (_, index) => (
        <EmptyCell key={`empty-${index}`} width={EMPTY_COLUMN_WIDTH} />
      ))}
    </div>
  )

  /**
   * A column's letter, and the separator that resizes it: by dragging, by a double-click that fits
   * the column to its values, or from the keyboard on the active cell's column, whose separator is
   * the one in the tab order.
   */
  const letter = (column: number, fixed: boolean) => {
    const selected = column >= range.left && column <= range.right
    const name = model.columns[column]?.name ?? ""
    const width = widths[column] ?? 0
    return (
      <div
        key={column}
        data-cell=""
        data-letter=""
        data-row={-1}
        data-column={column}
        className={cn(
          "relative flex shrink-0 items-center justify-center border-r border-b border-border text-[11px] select-none",
          selected ? SELECTED_LETTER : GUTTER,
          // The selection's own outline marks a column it reaches the top of: a rule there too
          // would draw a double line over the header row.
          selected && range.top > 0 && "shadow-[inset_0_-2px_0_var(--primary)]",
          fixed && "sticky z-[2]"
        )}
        style={{
          width,
          ...(fixed ? { left: rowNumberWidth + (offsets[column] ?? 0) } : {}),
        }}
      >
        <span aria-hidden="true">{columnLetter(column)}</span>
        <ColumnMenu name={name} actions={columnActions(column)} />
        <span
          role="separator"
          aria-orientation="vertical"
          aria-label={messages.resize(name)}
          aria-valuenow={width}
          aria-valuemin={MIN_COLUMN_WIDTH}
          aria-valuemax={MAX_COLUMN_WIDTH}
          tabIndex={column === focus.column ? 0 : -1}
          className="absolute inset-y-0 -right-[3px] z-[3] w-[6px] cursor-col-resize outline-none after:absolute after:inset-y-1 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent hover:after:bg-primary focus-visible:after:w-0.5 focus-visible:after:bg-ring"
          onPointerDown={(event) => resize(column, event)}
          onDoubleClick={() => setWidth(column, fit(column))}
          onKeyDown={(event) => resizeWithKey(column, event)}
        />
      </div>
    )
  }

  const frozen: number[] = Array.from({ length: frozenRows }, (_, index) => index)
  const body: number[] = []
  for (let index = rows.first; index <= rows.last; index += 1) body.push(frozenRows + index)
  // Focus stays on the grid while the arrows move the active cell, which assistive technology
  // follows by its id: only while it is drawn, since only the cells in view are.
  const drawn = (point: CellPoint) =>
    (point.row < frozenRows ||
      (point.row >= frozenRows + rows.first && point.row <= frozenRows + rows.last)) &&
    (point.column < frozenColumns || (point.column >= firstColumn && point.column <= columns.last))

  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild>
        <div
          ref={scrollRef}
          onContextMenu={onContextMenu}
          className={cn(
            "relative min-h-0 min-w-0 overflow-auto bg-(--sheet-cell) text-[13px] text-foreground has-[[role=grid]:focus-visible]:ring-2 has-[[role=grid]:focus-visible]:ring-ring has-[[role=grid]:focus-visible]:ring-inset",
            SHEET_PALETTE,
            className
          )}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onDoubleClick={(event) => {
            const target = (event.target as HTMLElement).closest<HTMLElement>("[data-cell]")
            const point = target ? cellPoint(target) : null
            if (!point || (event.target as HTMLElement).closest("input, button")) return
            // A header's name is changed in the column's settings.
            if (editor && point.row === 0 && point.column >= 0)
              editor.editColumn(point.column, "name")
            else startEdit(point)
          }}
        >
          <div
            className="flex flex-col overflow-clip"
            style={{ width: viewWidth, height: viewHeight }}
          >
            <div
              ref={gridRef}
              role="grid"
              aria-label={messages.grid(model.name)}
              aria-rowcount={rowCount + (totals ? 1 : 0)}
              // The row numbers are the first column.
              aria-colcount={columnCount + 1}
              aria-multiselectable="true"
              aria-activedescendant={drawn(focus) ? cellId(focus.row, focus.column) : undefined}
              tabIndex={0}
              className="flex-1 outline-none"
              onKeyDown={onKeyDown}
              onPaste={onPaste}
            >
              <div
                role="rowgroup"
                className={cn(
                  "sticky z-[3]",
                  // Rows scrolled under the frozen ones pass beneath a shadow, as in a spreadsheet.
                  viewport.top > 0
                    ? "shadow-[0_1px_0_var(--border),0_5px_8px_-5px_rgb(0_0_0/0.18)]"
                    : "shadow-[0_1px_0_var(--border)]"
                )}
                style={{ top: LETTER_HEIGHT }}
              >
                {frozen.map(renderRow)}
              </div>
              <div role="rowgroup" style={{ paddingTop: rows.first * ROW_HEIGHT }}>
                {body.map(renderRow)}
              </div>
              {totalsRow()}
              {emptyRows > 0 ? (
                <div aria-hidden="true">
                  {Array.from({ length: emptyRows }, (_, index) => emptyRow(rowCount + index))}
                </div>
              ) : null}
            </div>
            {/* The letters lead the grid on screen and follow it in the tab order: they are not
            cells, only the columns' names and the handles that resize them. */}
            <div
              // It keeps its height while the empty rows past the data overflow the clipped view.
              className="sticky top-0 z-[4] order-first flex shrink-0 overflow-clip"
              style={{ width: viewWidth, height: LETTER_HEIGHT }}
            >
              <button
                type="button"
                aria-label={messages.selectAllCells}
                title={messages.selectAllCells}
                onClick={() => {
                  setAnchor({ row: 0, column: 0 })
                  setFocus({ row: rowCount - 1, column: columnCount - 1 })
                  gridRef.current?.focus({ preventScroll: true })
                }}
                className={cn(
                  "group sticky left-0 z-[3] shrink-0 border-r border-b border-border outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                  GUTTER
                )}
                style={{ width: rowNumberWidth }}
              >
                {/* The corner's triangle, as a spreadsheet's select-all corner has. */}
                <svg
                  aria-hidden="true"
                  viewBox="0 0 10 10"
                  className="absolute right-1 bottom-1 size-2.5 fill-muted-foreground/45 transition-colors group-hover:fill-primary"
                >
                  <path d="M10 0V10H0Z" />
                </svg>
              </button>
              {fixedColumns.map((column) => letter(column, true))}
              {leadingSpace > 0 ? (
                <div className="shrink-0" style={{ width: leadingSpace }} />
              ) : null}
              {scrollingColumns.map((column) => letter(column, false))}
              {Array.from({ length: emptyColumns }, (_, index) => (
                <div
                  key={`empty-${index}`}
                  aria-hidden="true"
                  className={cn(
                    "flex shrink-0 items-center justify-center border-r border-b border-border text-[11px] text-muted-foreground/70 select-none",
                    GUTTER
                  )}
                  style={{ width: EMPTY_COLUMN_WIDTH }}
                >
                  {columnLetter(columnCount + index)}
                </div>
              ))}
            </div>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent
        className="min-w-52"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          // Choosing Filter leaves focus with the filter it opened; anything else, with the grid.
          if (!contextFiltering.current) gridRef.current?.focus({ preventScroll: true })
          contextFiltering.current = false
        }}
      >
        {contextTarget?.kind === "column" && !contextTarget.cell ? null : (
          <ContextMenuItem onSelect={() => void copy()}>
            <Copy aria-hidden="true" />
            {messages.copy}
          </ContextMenuItem>
        )}
        {editor &&
        (contextTarget?.kind === "row" ||
          (contextTarget?.kind === "column" && contextTarget.cell)) &&
        range.bottom > 0 ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => insertRowsBeside("above")}>
              <ArrowUpToLine aria-hidden="true" />
              {messages.insertRowsAbove(selectedRows().length || 1)}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => insertRowsBeside("below")}>
              <ArrowDownToLine aria-hidden="true" />
              {messages.insertRowsBelow(selectedRows().length || 1)}
            </ContextMenuItem>
            <ContextMenuItem variant="destructive" onSelect={deleteSelectedRows}>
              <Trash2 aria-hidden="true" />
              {messages.deleteRows(selectedRows().length)}
            </ContextMenuItem>
          </>
        ) : null}
        {contextTarget?.kind === "column" ? (
          <>
            {contextTarget.cell ? <ContextMenuSeparator /> : null}
            <ColumnMenuItems
              actions={{
                ...columnActions(contextTarget.column),
                onFilter: () => {
                  contextFiltering.current = true
                  openFilter(contextTarget.column)
                },
              }}
              parts={CONTEXT_PARTS}
              messages={messages}
            />
          </>
        ) : null}
      </ContextMenuContent>
      {notice ? (
        <div
          role="status"
          className="pointer-events-none absolute bottom-12 left-1/2 z-10 w-max max-w-[min(36rem,calc(100%-2rem))] -translate-x-1/2 rounded-full border border-border bg-popover px-3.5 py-1.5 text-center text-xs font-medium text-balance text-popover-foreground shadow-[0_8px_24px_-12px_rgb(0_0_0/0.35)] motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1"
        >
          {notice}
        </div>
      ) : null}
    </ContextMenu>
  )
}

/** How long a word on a paste stays over the grid. */
const NOTICE_MS = 4000

/** The rows' order while the sheet is edited, and what it was worked out from. */
interface HeldOrder {
  readonly sort: SheetView["sort"]
  readonly filters: SheetView["filters"]
  readonly locale: string
  readonly rows: number
  readonly order: readonly number[]
}

/** What a right-click landed on: a column's letter or a cell in it, a row's number, or neither. */
type ContextTarget =
  | { readonly kind: "column"; readonly column: number; readonly cell?: boolean }
  | { readonly kind: "row" }
  | null

/**
 * A header's filter button in filter mode, at the cell's right edge as a spreadsheet's is: it
 * shows the column's filter or sort when it has one, and opens its sort and filter.
 */
function FilterButton({
  name,
  filtered,
  sort,
  open,
  onOpenChange,
  children,
}: {
  readonly name: string
  readonly filtered: boolean
  readonly sort: SortDirection | null
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly children: ReactNode
}) {
  const messages = useArtifactMessages().sheet
  const Icon = filtered
    ? Filter
    : sort === "ascending"
      ? ArrowUp
      : sort === "descending"
        ? ArrowDown
        : ChevronDown
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        aria-label={messages.filterColumn(name)}
        title={messages.filterColumn(name)}
        data-filtered={filtered ? "" : undefined}
        className={cn(
          "absolute top-1/2 right-1 flex size-[18px] -translate-y-1/2 items-center justify-center rounded-[4px] border bg-card shadow-[0_1px_1px_rgb(0_0_0/0.05)] outline-none transition-colors hover:border-foreground/30 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:border-primary",
          filtered || sort
            ? "border-primary/40 text-primary"
            : "border-border text-muted-foreground"
        )}
      >
        <Icon className={cn("size-3", filtered && "size-2.5 fill-current")} aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-3">
        {children}
      </PopoverContent>
    </Popover>
  )
}

// Column letters and row numbers are opaque: a translucent blur on every sticky cell costs a
// backdrop filter per cell on each scrolled frame. Mixes of theme surfaces use oklab: near-grey
// surfaces have no reliable hue, and an oklch mix can fall back to hue 0 and tint them pink.
const GUTTER = "bg-(--sheet-chrome) text-muted-foreground"

/**
 * A selected column's letter and a selected row's number, tinted. A letter also takes the accent's
 * rule when the selection starts below the header; a rule beside a row's number would double the
 * selection's outline next to it.
 */
const SELECTED_LETTER =
  "bg-[color-mix(in_oklab,var(--primary)_10%,var(--sheet-chrome))] font-semibold text-foreground"
const SELECTED_ROW_NUMBER =
  "bg-[color-mix(in_oklab,var(--primary)_10%,var(--sheet-chrome))] font-semibold text-foreground"

/**
 * The grid's surfaces from the theme: white cells on the chrome of letters and row numbers, a
 * header row a shade off the cells, and hairline gridlines, so a project's theme and dark mode
 * carry through.
 */
const SHEET_PALETTE =
  "[--sheet-cell:var(--card)] [--sheet-chrome:color-mix(in_oklab,var(--muted)_65%,var(--background))] [--sheet-header:color-mix(in_oklab,var(--muted)_42%,var(--card))] [--sheet-line:color-mix(in_oklab,var(--border)_80%,transparent)]"

/** The most of the grid's width frozen columns may take, so the rest still scrolls. */
const FROZEN_SHARE = 0.6

const MOVE_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"])

function cellPoint(element: HTMLElement): CellPoint | null {
  const row = Number(element.dataset.row)
  const column = Number(element.dataset.column)
  return Number.isInteger(row) && Number.isInteger(column) ? { row, column } : null
}
