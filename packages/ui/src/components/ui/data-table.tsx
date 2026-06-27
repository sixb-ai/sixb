"use client"

import { cn } from "@sixb/ui/lib/utils"
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type RowData,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table"
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react"
import * as React from "react"
import { Skeleton } from "./skeleton"

// Lets a column carry presentational hints (right-align numerics, a type
// caption under the header) without leaking into the row data.
declare module "@tanstack/react-table" {
  interface ColumnMeta<TData extends RowData, TValue> {
    align?: "left" | "right"
    typeLabel?: React.ReactNode
  }
}

export interface DataTableColumn<TData> {
  /** Stable id; also the key used for sizing/sorting state. */
  id: string
  /** Header label (string or node). */
  header: React.ReactNode
  /** Optional caption rendered under the header (e.g. a column type). */
  typeLabel?: React.ReactNode
  /** Reads the cell value from a row. */
  accessor: (row: TData) => unknown
  /** Renders the cell. Defaults to the stringified value. */
  cell?: (value: unknown, row: TData) => React.ReactNode
  align?: "left" | "right"
  size?: number
  minSize?: number
  enableSorting?: boolean
}

interface DataTableProps<TData> {
  columns: DataTableColumn<TData>[]
  data: TData[]
  /** Render a sticky left gutter with 1-based row numbers. */
  showRowIndex?: boolean
  /** Added to the row's original index for the gutter number. */
  rowIndexOffset?: number
  onCellClick?: (cell: { columnId: string; value: unknown; row: TData; rowIndex: number }) => void
  isLoading?: boolean
  /** Shown when there are no rows (and not loading). */
  empty?: React.ReactNode
  /** Applied to the scroll container. */
  className?: string
}

const GUTTER_WIDTH = 56
const skeletonRows = Array.from({ length: 14 }, (_, index) => `dt-skeleton-${index}`)

export function DataTable<TData>({
  columns,
  data,
  showRowIndex = false,
  rowIndexOffset = 0,
  onCellClick,
  isLoading = false,
  empty,
  className,
}: DataTableProps<TData>) {
  const [sorting, setSorting] = React.useState<SortingState>([])

  const columnDefs = React.useMemo<ColumnDef<TData>[]>(
    () =>
      columns.map((column) => ({
        id: column.id,
        accessorFn: (row) => column.accessor(row),
        header: () => column.header,
        cell: (info) =>
          column.cell ? column.cell(info.getValue(), info.row.original) : String(info.getValue()),
        enableSorting: column.enableSorting ?? true,
        size: column.size,
        minSize: column.minSize ?? 80,
        meta: { align: column.align, typeLabel: column.typeLabel },
      })),
    [columns]
  )

  const table = useReactTable({
    data,
    columns: columnDefs,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    enableColumnResizing: true,
    columnResizeMode: "onChange",
    defaultColumn: { size: 200, minSize: 80, maxSize: 800 },
  })

  if (isLoading) {
    return (
      <div className={cn("min-h-0 flex-1 space-y-px overflow-hidden p-3", className)}>
        {skeletonRows.map((key) => (
          <Skeleton key={key} className="h-7 w-full" />
        ))}
      </div>
    )
  }

  if (data.length === 0) {
    return (
      <div className={cn("flex min-h-0 flex-1 items-center justify-center p-6", className)}>
        {empty}
      </div>
    )
  }

  const cellPadY = "py-1"
  const cellText = "text-[11px]"
  const totalWidth = table.getTotalSize() + (showRowIndex ? GUTTER_WIDTH : 0)

  return (
    <div className={cn("min-h-0 flex-1 overflow-auto", className)}>
      <table
        className="border-separate border-spacing-0 text-left"
        style={{ width: totalWidth, tableLayout: "fixed" }}
      >
        <colgroup>
          {showRowIndex ? <col style={{ width: GUTTER_WIDTH }} /> : null}
          {table.getVisibleLeafColumns().map((column) => (
            <col key={column.id} style={{ width: column.getSize() }} />
          ))}
        </colgroup>

        <thead>
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {showRowIndex ? (
                <th className="sticky left-0 top-0 z-30 h-9 border-b border-r border-border bg-muted align-middle">
                  <span className="block pr-2 text-right text-[10px] font-medium tabular-nums text-muted-foreground">
                    #
                  </span>
                </th>
              ) : null}
              {headerGroup.headers.map((header) => {
                const meta = header.column.columnDef.meta
                const sorted = header.column.getIsSorted()
                const canSort = header.column.getCanSort()
                return (
                  <th
                    key={header.id}
                    className="group/h sticky top-0 z-20 border-b border-r border-border bg-muted p-0 align-bottom last:border-r-0"
                  >
                    <button
                      type="button"
                      onClick={header.column.getToggleSortingHandler()}
                      disabled={!canSort}
                      className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left transition-colors enabled:hover:bg-muted-foreground/10"
                    >
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-mono text-[11px] font-medium text-foreground">
                          {flexRender(header.column.columnDef.header, header.getContext())}
                        </span>
                        {meta?.typeLabel ? (
                          <span className="truncate font-mono text-[10px] font-normal text-muted-foreground">
                            {meta.typeLabel}
                          </span>
                        ) : null}
                      </span>
                      {sorted === "asc" ? (
                        <ArrowUp className="size-3 shrink-0 text-foreground" />
                      ) : sorted === "desc" ? (
                        <ArrowDown className="size-3 shrink-0 text-foreground" />
                      ) : canSort ? (
                        <ChevronsUpDown className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/h:opacity-60" />
                      ) : null}
                    </button>
                    {header.column.getCanResize() ? (
                      <button
                        type="button"
                        tabIndex={-1}
                        aria-hidden="true"
                        onMouseDown={header.getResizeHandler()}
                        onTouchStart={header.getResizeHandler()}
                        onClick={(event) => event.stopPropagation()}
                        className={cn(
                          "absolute right-0 top-0 z-10 h-full w-1.5 cursor-col-resize touch-none select-none bg-transparent transition-colors hover:bg-primary/40",
                          header.column.getIsResizing() && "bg-primary/60"
                        )}
                      />
                    ) : null}
                  </th>
                )
              })}
            </tr>
          ))}
        </thead>

        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id} className="group">
              {showRowIndex ? (
                <td
                  className={cn(
                    "sticky left-0 z-10 border-b border-r border-border bg-card text-right align-top tabular-nums text-[10px] text-muted-foreground transition-colors group-hover:bg-muted",
                    cellPadY
                  )}
                >
                  <span className="block pr-2">{rowIndexOffset + row.index + 1}</span>
                </td>
              ) : null}
              {row.getVisibleCells().map((cell) => {
                const align = cell.column.columnDef.meta?.align
                return (
                  <td
                    key={cell.id}
                    onClick={
                      onCellClick
                        ? () =>
                            onCellClick({
                              columnId: cell.column.id,
                              value: cell.getValue(),
                              row: row.original,
                              rowIndex: row.index,
                            })
                        : undefined
                    }
                    className={cn(
                      "border-b border-r border-border align-top transition-colors last:border-r-0 group-hover:bg-muted",
                      "px-3",
                      cellPadY,
                      cellText,
                      align === "right" && "text-right tabular-nums",
                      onCellClick && "cursor-pointer"
                    )}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
