import { cn } from "@sixb/ui/lib/utils"
import { ArrowDown, ArrowUp, ArrowUpDown, CalendarDays, Image, Link2 } from "lucide-react"
import {
  type CSSProperties,
  type KeyboardEvent,
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
import { ArtifactAddressLabel, ArtifactLink } from "../../references/references"
import { cellFormatter, currencySymbol, type FormattedCell } from "./format"
import type { SheetColumn, SheetModel } from "./model"
import {
  type CellPoint,
  type CellRange,
  cellRange,
  columnLetter,
  inRange,
  type MoveKey,
  moveFocus,
  type RangeStats,
  rangeStats,
  rangeTsv,
  type SortDirection,
  sortedOrder,
} from "./selection"
import { prefixOffsets, visibleRowSpan, visibleSpan } from "./virtual"

const ROW_HEIGHT = 32
const LETTER_HEIGHT = 26
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
}

/**
 * A read-only spreadsheet grid: column letters and row numbers, the header row and any frozen rows
 * and columns kept in view, columns that resize and sort, and a selection by pointer, Shift, and
 * keyboard that copies as TSV. Only the cells in view are drawn, so a sheet of 100,000 rows
 * scrolls like a short one.
 */
export function SheetGrid({
  model,
  locale,
  onStatusChange,
  imageUrl,
  selected,
  className,
}: {
  readonly model: SheetModel
  readonly locale: string
  readonly onStatusChange?: (status: SheetGridStatus) => void
  /** An image cell's URL by its path in the artifact; images show only where they resolve. */
  readonly imageUrl?: (path: string) => string | undefined
  /** A range to open on, selected and in view, such as the one an address named. */
  readonly selected?: CellRange
  readonly className?: string
}) {
  const messages = useArtifactMessages().sheet
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const gridRef = useRef<HTMLDivElement | null>(null)
  const idPrefix = useId()
  const cellId = (row: number, column: number) => `${idPrefix}-${row}-${column}`
  const [viewport, setViewport] = useState({ top: 0, left: 0, width: 960, height: 640 })
  const [widths, setWidths] = useState(() => model.columns.map((column) => column.width))
  const [sort, setSort] = useState<{ column: number; direction: SortDirection } | null>(null)
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
  const dragging = useRef(false)

  const order = useMemo(() => sortedOrder(model, sort, locale), [model, sort, locale])
  const formatters = useMemo(
    () => model.columns.map((column) => cellFormatter(column, locale)),
    [model, locale]
  )
  const rowCount = model.rows.length + 1
  const columnCount = model.columns.length
  const range = useMemo(() => cellRange(anchor, focus), [anchor, focus])

  // Layout, in content pixels.
  const rowNumberWidth = Math.max(44, String(rowCount).length * 8 + 24)
  const offsets = useMemo(() => prefixOffsets(widths), [widths])
  const frozenColumns = model.frozenColumns
  const frozenRows = Math.min(model.frozenRows, rowCount)
  const frozenWidth = offsets[frozenColumns] ?? 0
  const totalWidth = rowNumberWidth + (offsets.at(-1) ?? 0)
  const headerHeight = LETTER_HEIGHT + frozenRows * ROW_HEIGHT
  const bodyRows = rowCount - frozenRows

  const columns = visibleSpan(
    offsets,
    viewport.left + frozenWidth,
    viewport.left + viewport.width - rowNumberWidth,
    OVERSCAN_COLUMNS
  )
  const firstColumn = Math.max(columns.first, frozenColumns)
  const scrollingColumns: number[] = []
  for (let column = firstColumn; column <= columns.last; column += 1) scrollingColumns.push(column)
  const fixedColumns = Array.from({ length: frozenColumns }, (_, index) => index)
  const leadingSpace = (offsets[firstColumn] ?? 0) - frozenWidth
  const rows = visibleRowSpan(
    ROW_HEIGHT,
    bodyRows,
    viewport.top,
    viewport.top + viewport.height - headerHeight,
    OVERSCAN_ROWS
  )

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
    onStatusChange?.({
      range,
      stats: rangeStats(range, model, order),
      column: model.columns[focus.column],
    })
  }, [onStatusChange, range, model, order, focus.column])

  useEffect(() => {
    const stop = () => {
      dragging.current = false
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
        else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight) {
          element.scrollTop = top + ROW_HEIGHT - element.clientHeight
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
    [frozenRows, frozenColumns, headerHeight, rowNumberWidth, offsets, frozenWidth]
  )

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

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-cell]")
    if (!target || (event.target as HTMLElement).closest("a, button")) return
    const point = cellPoint(target)
    if (!point) return
    event.preventDefault()
    gridRef.current?.focus({ preventScroll: true })
    dragging.current = true
    if (point.column < 0) {
      // A row number selects its row.
      setAnchor({ row: point.row, column: 0 })
      setFocus({ row: point.row, column: columnCount - 1 })
      return
    }
    if (point.row < 0) {
      // A column letter selects its column.
      setAnchor({ row: 0, column: point.column })
      setFocus({ row: rowCount - 1, column: point.column })
      return
    }
    select(point, event.shiftKey)
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-cell]")
    const point = target ? cellPoint(target) : null
    if (!point || point.row < 0 || point.column < 0) return
    if (point.row !== focus.row || point.column !== focus.column) setFocus(point)
  }

  const onKeyDown = async (event: KeyboardEvent<HTMLDivElement>) => {
    const command = event.metaKey || event.ctrlKey
    if (command && event.key.toLowerCase() === "a") {
      event.preventDefault()
      setAnchor({ row: 0, column: 0 })
      setFocus({ row: rowCount - 1, column: columnCount - 1 })
      return
    }
    if (command && event.key.toLowerCase() === "c") {
      event.preventDefault()
      try {
        await navigator.clipboard.writeText(rangeTsv(range, model, order))
      } catch {
        // The clipboard can be unavailable, such as on an insecure origin.
      }
      return
    }
    if (event.key === "Escape") {
      setAnchor(focus)
      return
    }
    const page = Math.max(1, Math.floor((viewport.height - headerHeight) / ROW_HEIGHT) - 1)
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
    select(next, event.shiftKey)
    reveal(next)
  }

  const setWidth = (column: number, width: number) => {
    const clamped = Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, width))
    setWidths((current) => current.map((value, index) => (index === column ? clamped : value)))
  }

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

  /** The arrows widen and narrow a column from its separator; Enter fits it as it opened. */
  const resizeWithKey = (column: number, event: KeyboardEvent<HTMLSpanElement>) => {
    const width = widths[column] ?? 0
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      setWidth(column, width + (event.key === "ArrowRight" ? RESIZE_STEP : -RESIZE_STEP))
    } else if (event.key === "Enter") {
      setWidth(column, model.columns[column]?.width ?? width)
    } else return
    event.preventDefault()
  }

  const cycleSort = (column: number) =>
    setSort((current) =>
      current?.column !== column
        ? { column, direction: "ascending" }
        : current.direction === "ascending"
          ? { column, direction: "descending" }
          : null
    )

  const valueAt = (row: number, column: number): string =>
    row === 0
      ? (model.columns[column]?.name ?? "")
      : (model.rows[order[row - 1] ?? -1]?.[column] ?? "")

  /** One grid row: its number, the frozen cells, then the cells in view. */
  const renderRow = (row: number) => {
    const header = row === 0
    const rowSelected = row >= range.top && row <= range.bottom
    const cell = (column: number, fixed: boolean) => {
      const width = widths[column] ?? 0
      const style: CSSProperties = {
        width,
        ...(fixed ? { left: rowNumberWidth + (offsets[column] ?? 0) } : {}),
        ...selectionEdges(range, row, column),
      }
      return (
        <GridCell
          key={column}
          id={cellId(row, column)}
          row={row}
          column={column}
          header={header}
          fixed={fixed}
          lastFixed={fixed && column === frozenColumns - 1}
          selected={inRange(range, row, column)}
          active={row === focus.row && column === focus.column}
          style={style}
        >
          {header ? (
            <HeaderContent
              column={model.columns[column]}
              sort={sort?.column === column ? sort.direction : null}
              onSort={() => cycleSort(column)}
              label={messages.sort(model.columns[column]?.name ?? "")}
            />
          ) : (
            <CellContent
              cell={formatters[column]?.(valueAt(row, column)) ?? { text: "" }}
              numeric={model.columns[column]?.numeric ?? false}
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
        className="flex"
        style={{ width: totalWidth, height: ROW_HEIGHT }}
      >
        <div
          data-cell=""
          data-row={row}
          data-column={-1}
          className={cn(
            "sticky left-0 z-[2] flex shrink-0 items-center justify-center border-r border-b border-border text-[11px] text-muted-foreground tabular-nums select-none",
            GUTTER,
            rowSelected && "bg-muted font-medium text-foreground",
            header && "border-b-border"
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
      </div>
    )
  }

  /**
   * A column's letter, and the separator that resizes it: by dragging, or from the keyboard on
   * the active cell's column, whose separator is the one in the tab order.
   */
  const letter = (column: number, fixed: boolean) => {
    const selected = column >= range.left && column <= range.right
    const name = model.columns[column]?.name ?? ""
    const width = widths[column] ?? 0
    return (
      <div
        key={column}
        data-cell=""
        data-row={-1}
        data-column={column}
        className={cn(
          "relative flex shrink-0 items-center justify-center border-r border-b border-border text-[11px] text-muted-foreground select-none",
          GUTTER,
          fixed && "sticky z-[2]",
          selected && "bg-muted font-medium text-foreground"
        )}
        style={{
          width,
          ...(fixed ? { left: rowNumberWidth + (offsets[column] ?? 0) } : {}),
        }}
      >
        <span aria-hidden="true">{columnLetter(column)}</span>
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
          onDoubleClick={() => setWidth(column, model.columns[column]?.width ?? width)}
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
    <div
      ref={scrollRef}
      className={cn(
        "relative min-h-0 min-w-0 overflow-auto bg-background text-[13px] text-foreground has-[[role=grid]:focus-visible]:ring-2 has-[[role=grid]:focus-visible]:ring-ring has-[[role=grid]:focus-visible]:ring-inset",
        className
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
    >
      <div
        className="flex flex-col"
        style={{ width: totalWidth, height: headerHeight + bodyRows * ROW_HEIGHT }}
      >
        <div
          ref={gridRef}
          role="grid"
          aria-label={messages.grid(model.name)}
          aria-rowcount={rowCount}
          // The row numbers are the first column.
          aria-colcount={columnCount + 1}
          aria-multiselectable="true"
          aria-activedescendant={drawn(focus) ? cellId(focus.row, focus.column) : undefined}
          tabIndex={0}
          className="flex-1 outline-none"
          onKeyDown={onKeyDown}
        >
          <div
            role="rowgroup"
            className="sticky z-[3] shadow-[0_1px_0_var(--border)]"
            style={{ top: LETTER_HEIGHT }}
          >
            {frozen.map(renderRow)}
          </div>
          <div role="rowgroup" style={{ paddingTop: rows.first * ROW_HEIGHT }}>
            {body.map(renderRow)}
          </div>
        </div>
        {/* The letters lead the grid on screen and follow it in the tab order: they are not
            cells, only the columns' names and the handles that resize them. */}
        <div
          className="sticky top-0 z-[4] order-first flex"
          style={{ width: totalWidth, height: LETTER_HEIGHT }}
        >
          <div
            className={cn("sticky left-0 z-[3] shrink-0 border-r border-b border-border", GUTTER)}
            style={{ width: rowNumberWidth }}
          />
          {fixedColumns.map((column) => letter(column, true))}
          {leadingSpace > 0 ? <div className="shrink-0" style={{ width: leadingSpace }} /> : null}
          {scrollingColumns.map((column) => letter(column, false))}
        </div>
      </div>
    </div>
  )
}

// Column letters and row numbers are opaque: a translucent blur on every sticky cell costs a
// backdrop filter per cell on each scrolled frame. Mixes of theme surfaces use oklab: near-grey
// surfaces have no reliable hue, and an oklch mix can fall back to hue 0 and tint them pink.
const GUTTER = "bg-[color-mix(in_oklab,var(--muted)_60%,var(--background))]"

const MOVE_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"])

function cellPoint(element: HTMLElement): CellPoint | null {
  const row = Number(element.dataset.row)
  const column = Number(element.dataset.column)
  return Number.isInteger(row) && Number.isInteger(column) ? { row, column } : null
}

/** The selection's outline, drawn on the cells along its edges so it stays one shape. */
function selectionEdges(range: CellRange, row: number, column: number): CSSProperties {
  if (!inRange(range, row, column)) return {}
  const color = "var(--primary)"
  const shadows = [
    row === range.top ? `inset 0 2px 0 0 ${color}` : "",
    row === range.bottom ? `inset 0 -2px 0 0 ${color}` : "",
    column === range.left ? `inset 2px 0 0 0 ${color}` : "",
    column === range.right ? `inset -2px 0 0 0 ${color}` : "",
  ].filter(Boolean)
  return shadows.length > 0 ? { boxShadow: shadows.join(", ") } : {}
}

function GridCell({
  id,
  row,
  column,
  header,
  fixed,
  lastFixed,
  selected,
  active,
  style,
  children,
}: {
  readonly id: string
  readonly row: number
  readonly column: number
  readonly header: boolean
  readonly fixed: boolean
  readonly lastFixed: boolean
  readonly selected: boolean
  readonly active: boolean
  readonly style: CSSProperties
  readonly children: ReactNode
}) {
  return (
    <div
      id={id}
      data-cell=""
      data-row={row}
      data-column={column}
      role={header ? "columnheader" : "gridcell"}
      // Columns are drawn only in view, so each says where it is; the row numbers come first.
      aria-colindex={column + 2}
      aria-selected={selected}
      className={cn(
        "flex shrink-0 items-center overflow-hidden border-r border-b border-border/70 px-2.5 whitespace-nowrap",
        header ? "bg-background font-semibold" : "bg-background",
        fixed && "sticky z-[1]",
        lastFixed && "shadow-[1px_0_0_var(--border)]",
        selected && !active && "bg-[color-mix(in_oklab,var(--primary)_7%,var(--background))]"
      )}
      style={style}
    >
      {children}
    </div>
  )
}

function HeaderContent({
  column,
  sort,
  onSort,
  label,
}: {
  readonly column: SheetColumn | undefined
  readonly sort: SortDirection | null
  readonly onSort: () => void
  readonly label: string
}) {
  const Icon = sort === "ascending" ? ArrowUp : sort === "descending" ? ArrowDown : ArrowUpDown
  return (
    <span
      className={cn(
        "flex min-w-0 flex-1 items-center gap-1.5",
        column?.numeric && "flex-row-reverse"
      )}
    >
      <span className="min-w-0 truncate">{column?.name}</span>
      <TypeGlyph column={column} />
      <span className="flex-1" />
      <button
        type="button"
        aria-label={label}
        aria-pressed={sort !== null}
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-opacity hover:bg-muted hover:text-foreground",
          sort
            ? "opacity-100"
            : "opacity-0 focus-visible:opacity-100 [[role=columnheader]:hover_&]:opacity-100"
        )}
        onClick={onSort}
      >
        <Icon className="size-3" aria-hidden="true" />
      </button>
    </span>
  )
}

/** A quiet mark of the column's type beside its name: `#`, its currency's sign, `%`, an icon. */
function TypeGlyph({ column }: { readonly column: SheetColumn | undefined }) {
  const type = column?.format.type
  const glyph =
    type === "number" ? (
      "#"
    ) : type === "percent" ? (
      "%"
    ) : type === "currency" ? (
      currencySymbol(column?.format.currency ?? "USD")
    ) : type === "date" ? (
      <CalendarDays className="size-3" />
    ) : type === "link" ? (
      <Link2 className="size-3" />
    ) : type === "image" ? (
      <Image className="size-3" />
    ) : null
  return glyph ? (
    <span
      className="flex shrink-0 items-center text-[11px] font-normal text-muted-foreground"
      aria-hidden="true"
    >
      {glyph}
    </span>
  ) : null
}

function CellContent({
  cell,
  numeric,
  imageUrl,
}: {
  readonly cell: FormattedCell
  readonly numeric: boolean
  readonly imageUrl?: (path: string) => string | undefined
}) {
  if (cell.reference) {
    return (
      <ArtifactLink
        address={cell.reference}
        className="truncate text-primary underline-offset-2 hover:underline"
      >
        <ArtifactAddressLabel address={cell.reference} />
      </ArtifactLink>
    )
  }
  if (cell.href) {
    return (
      <a
        href={cell.href}
        target="_blank"
        rel="noreferrer noopener"
        className="truncate text-primary underline-offset-2 hover:underline"
      >
        {cell.text}
      </a>
    )
  }
  if (cell.image) {
    const src = imageUrl?.(cell.image)
    return (
      <span className="flex min-w-0 items-center gap-2">
        {src ? <img src={src} alt="" className="size-6 shrink-0 rounded object-cover" /> : null}
        <span className="truncate text-muted-foreground">{cell.text}</span>
      </span>
    )
  }
  return (
    <span
      className={cn(
        "min-w-0 flex-1 truncate",
        numeric && "text-right tabular-nums",
        cell.negative && "text-destructive"
      )}
    >
      {cell.text}
    </span>
  )
}
