import { cn } from "@sixb/ui/lib/utils"
import { ArrowDown, ArrowUp, CalendarDays, Image, Link2 } from "lucide-react"
import type { CSSProperties, ReactNode } from "react"
import { ArtifactAddressLabel, ArtifactLink } from "../../references/references"
import { currencySymbol, type FormattedCell } from "./format"
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
  selected,
  active,
  matched,
  sort,
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
  /** It holds what the find bar searches for. */
  readonly matched: boolean
  /** How the sheet is sorted by this column, for a header cell. */
  readonly sort?: SortDirection
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
      className={cn(
        "flex shrink-0 items-center overflow-hidden border-r border-b border-border/70 px-2.5 whitespace-nowrap",
        header ? "bg-background font-semibold" : "bg-background",
        fixed && "sticky z-[1]",
        lastFixed && "shadow-[1px_0_0_var(--border)]",
        selected &&
          !active &&
          !matched &&
          "bg-[color-mix(in_oklab,var(--primary)_7%,var(--background))]",
        // Matches are marked as a page's find marks them; the current one, the active cell, more.
        matched &&
          (active
            ? "bg-[color-mix(in_oklab,var(--warning)_45%,var(--background))]"
            : "bg-[color-mix(in_oklab,var(--warning)_20%,var(--background))]")
      )}
      data-matched={matched ? "" : undefined}
      style={style}
    >
      {children}
    </div>
  )
}

export function HeaderContent({
  column,
  sort,
  filter,
  menu,
}: {
  readonly column: SheetColumn | undefined
  readonly sort: SortDirection | null
  readonly filter: ReactNode
  readonly menu: ReactNode
}) {
  const Icon = sort === "ascending" ? ArrowUp : sort === "descending" ? ArrowDown : null
  return (
    <span
      className={cn(
        "flex min-w-0 flex-1 items-center gap-1.5",
        column?.numeric && "flex-row-reverse"
      )}
    >
      <span className="min-w-0 truncate">{column?.name}</span>
      <TypeGlyph column={column} />
      {Icon ? <Icon className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
      <span className="flex-1" />
      {filter}
      {menu}
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

export function CellContent({
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
