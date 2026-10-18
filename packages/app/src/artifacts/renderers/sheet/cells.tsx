import { cn } from "@sixb/ui/lib/utils"
import {
  ArrowDown,
  ArrowUp,
  CalendarDays,
  Check,
  Image,
  Link2,
  SquareCheck,
  Tag,
} from "lucide-react"
import type { CSSProperties, ReactNode } from "react"
import type { ArtifactMessages } from "../../messages"
import { ArtifactAddressLabel, ArtifactLink } from "../../references/references"
import { currencySymbol, type FormattedCell } from "./format"
import { type CellHighlight, TONE_COLORS } from "./highlight"
import type { SheetColumn } from "./model"
import { type CellRange, inRange, type SortDirection } from "./selection"

/** The selection's outline, drawn on the cells along its edges so it stays one shape. */
export function selectionEdges(range: CellRange, row: number, column: number): CSSProperties {
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

export function GridCell({
  id,
  row,
  column,
  header,
  fixed,
  lastFixed,
  scrolled,
  selected,
  active,
  corner,
  matched,
  spill,
  covered,
  sort,
  title,
  description,
  highlight,
  style,
  children,
}: {
  readonly id: string
  readonly row: number
  readonly column: number
  readonly header: boolean
  readonly fixed: boolean
  readonly lastFixed: boolean
  /** The grid is scrolled sideways, so the last frozen column casts a shadow over the rest. */
  readonly scrolled: boolean
  readonly selected: boolean
  readonly active: boolean
  /** The selection's bottom right cell, which carries a spreadsheet's fill handle. */
  readonly corner: boolean
  /** It holds what the find bar searches for. */
  readonly matched: boolean
  /** Its text runs on over empty cells to its right, this many pixels wide in all. */
  readonly spill?: number
  /** Its cell is empty and a cell to its left runs text over it, up to its edge or past it. */
  readonly covered?: "through" | "end"
  /** How the sheet is sorted by this column, for a header cell. */
  readonly sort?: SortDirection
  /** What a header's column holds, shown on hover. */
  readonly title?: string
  /** What a header's column means, from the workbook, for assistive technology. */
  readonly description?: string
  /** A bar or shade by the cell's value in its column. The selection's tint covers a shade. */
  readonly highlight?: CellHighlight
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
      aria-sort={sort}
      aria-description={description}
      title={title}
      className={cn(
        "flex shrink-0 items-center border-r border-b border-(--sheet-line) px-2 whitespace-nowrap",
        header ? "border-b-border bg-(--sheet-header) font-semibold" : "bg-(--sheet-cell)",
        fixed ? "sticky z-[1]" : "relative",
        spill === undefined ? "overflow-hidden" : "overflow-visible",
        // Text that runs on draws over the gridlines it crosses, as a spreadsheet's does.
        (spill !== undefined || covered === "through") && "border-r-transparent",
        lastFixed &&
          (scrolled
            ? "shadow-[1px_0_0_var(--border),5px_0_8px_-5px_rgb(0_0_0/0.18)]"
            : "shadow-[1px_0_0_var(--border)]"),
        selected &&
          !active &&
          !matched &&
          "bg-[color-mix(in_oklab,var(--primary)_8%,var(--sheet-cell))]",
        // Matches are marked as a page's find marks them; the current one, the active cell, more.
        matched &&
          (active
            ? "bg-[color-mix(in_oklab,var(--warning)_45%,var(--sheet-cell))]"
            : "bg-[color-mix(in_oklab,var(--warning)_20%,var(--sheet-cell))]")
      )}
      data-matched={matched ? "" : undefined}
      style={
        highlight?.kind === "shade" && !selected && !matched
          ? { ...style, backgroundColor: highlight.color }
          : style
      }
    >
      {highlight?.kind === "bar" ? (
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-y-[5px] rounded-[3px]",
            highlight.negative
              ? "bg-[color-mix(in_oklab,var(--destructive)_24%,transparent)]"
              : "bg-[color-mix(in_oklab,var(--foreground)_11%,transparent)]"
          )}
          style={{
            left: `calc(4px + (100% - 8px) * ${highlight.from})`,
            width: `calc((100% - 8px) * ${highlight.to - highlight.from})`,
          }}
        />
      ) : null}
      {children}
      {corner ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute right-0 bottom-0 z-[2] size-[7px] bg-primary ring-1 ring-(--sheet-cell)"
        />
      ) : null}
    </div>
  )
}

/** A cell past the sheet's data, drawn so the grid's lines run to the edge of the view. */
export function EmptyCell({
  width,
  fixed,
  left,
  through,
}: {
  readonly width: number
  readonly fixed?: boolean
  readonly left?: number
  /** Text from a cell to its left runs on past it, so its right gridline does not show. */
  readonly through?: boolean
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "shrink-0 border-r border-b border-(--sheet-line) bg-(--sheet-cell)",
        fixed && "sticky z-[1]",
        through && "border-r-transparent"
      )}
      style={{ width, ...(left === undefined ? {} : { left }) }}
    />
  )
}

/**
 * A header cell's content: the column's name whole, its type's mark, and the sort arrow. In filter
 * mode the filter button sits over the cell's right edge, and the name keeps clear of it.
 */
export function HeaderContent({
  column,
  sort,
  filterButton,
}: {
  readonly column: SheetColumn | undefined
  readonly sort: SortDirection | null
  readonly filterButton?: ReactNode
}) {
  // The filter button shows the sort in filter mode.
  const Icon = filterButton || !sort ? null : sort === "ascending" ? ArrowUp : ArrowDown
  return (
    <>
      <span
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1.5",
          column?.numeric && "flex-row-reverse",
          filterButton && "pr-5"
        )}
      >
        {/* A described column's name is underlined as a term with more to read on hover. */}
        <span
          className={cn(
            "min-w-0 truncate",
            column?.description &&
              "underline decoration-muted-foreground/45 decoration-dotted underline-offset-[3px]"
          )}
        >
          {column?.name}
        </span>
        <TypeGlyph column={column} />
        {Icon ? (
          <Icon className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
        ) : null}
      </span>
      {filterButton}
    </>
  )
}

/** A column's type in words: `Currency · USD`, `Percent`, `Text`. */
export function columnTypeLabel(column: SheetColumn, messages: ArtifactMessages["sheet"]): string {
  const { types } = messages
  return column.format.type === "currency"
    ? types.currency(column.format.currency ?? "USD")
    : types[column.format.type]
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
    ) : type === "boolean" ? (
      <SquareCheck className="size-3" />
    ) : type === "tag" ? (
      <Tag className="size-3" />
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

/**
 * A cell of the totals row pinned under the rows: a column's total, the word "Total" in the first
 * column without one, or nothing. It is not a cell of the sheet: selection and addresses pass it.
 */
export function TotalCell({
  text,
  label,
  title,
  fixed,
  lastFixed,
  scrolled,
  style,
}: {
  readonly text: string
  /** It names the row rather than totaling a column. */
  readonly label: boolean
  readonly title?: string
  readonly fixed: boolean
  readonly lastFixed: boolean
  readonly scrolled: boolean
  readonly style: CSSProperties
}) {
  return (
    <div
      role="gridcell"
      title={title}
      className={cn(
        "flex shrink-0 items-center overflow-hidden border-r border-(--sheet-line) bg-(--sheet-header) px-2 font-semibold whitespace-nowrap tabular-nums",
        fixed ? "sticky z-[1]" : "relative",
        !label && "justify-end",
        lastFixed &&
          (scrolled
            ? "shadow-[1px_0_0_var(--border),5px_0_8px_-5px_rgb(0_0_0/0.18)]"
            : "shadow-[1px_0_0_var(--border)]")
      )}
      style={style}
    >
      <span className="min-w-0 overflow-hidden text-ellipsis">{text}</span>
    </div>
  )
}

export function CellContent({
  cell,
  numeric,
  spill,
  imageUrl,
}: {
  readonly cell: FormattedCell
  readonly numeric: boolean
  /** The width the text runs on to over empty cells to its right. */
  readonly spill?: number
  readonly imageUrl?: (path: string) => string | undefined
}) {
  if (cell.reference) {
    return (
      <ArtifactLink
        address={cell.reference}
        className="min-w-0 overflow-hidden text-primary underline-offset-2 hover:underline"
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
        className="min-w-0 overflow-hidden text-primary underline-offset-2 hover:underline"
      >
        {cell.text}
      </a>
    )
  }
  if (cell.image) {
    const src = imageUrl?.(cell.image)
    return (
      <span className="flex min-w-0 items-center gap-2">
        {src ? <img src={src} alt="" className="size-5 shrink-0 rounded object-cover" /> : null}
        <span className="min-w-0 overflow-hidden text-muted-foreground">{cell.text}</span>
      </span>
    )
  }
  if (cell.check !== undefined) {
    // A read-only checkbox, centred as a spreadsheet's is.
    return (
      <span className="flex min-w-0 flex-1 justify-center">
        <span
          role="img"
          aria-label={cell.text}
          className={cn(
            "flex size-[15px] items-center justify-center rounded-[4px] border",
            cell.check
              ? "border-foreground bg-foreground text-background"
              : "border-[color-mix(in_oklab,var(--foreground)_28%,transparent)]"
          )}
        >
          {cell.check ? <Check className="size-[11px]" strokeWidth={3} /> : null}
        </span>
      </span>
    )
  }
  if (cell.tag) {
    const color = TONE_COLORS[cell.tag]
    return (
      <span
        className="min-w-0 truncate rounded-full px-2 py-px text-[12px] leading-[18px] font-medium"
        style={{
          backgroundColor: `color-mix(in oklab, ${color} 14%, var(--sheet-cell))`,
          color: `color-mix(in oklab, ${color} 70%, var(--foreground))`,
        }}
      >
        {cell.text}
      </span>
    )
  }
  if (spill !== undefined) {
    return (
      <span
        className="pointer-events-none absolute inset-y-0 left-0 z-[1] flex items-center overflow-hidden px-2"
        style={{ width: spill }}
      >
        {cell.text}
      </span>
    )
  }
  // A cell's text stops at its edge, as a spreadsheet's does; the formula bar shows it whole.
  return (
    <span
      className={cn(
        "min-w-0 flex-1 overflow-hidden",
        (numeric || cell.number) && "text-right tabular-nums",
        cell.negative && "text-destructive"
      )}
    >
      {cell.text}
    </span>
  )
}
