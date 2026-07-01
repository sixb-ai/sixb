import {
  Button,
  DataTable,
  type DataTableColumn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { Check, Copy, Database } from "lucide-react"
import { useMemo, useState } from "react"
import {
  type FileRefValue,
  fileMediaLabel,
  fileRefName,
  formatFileSize,
  isFileRefValue,
} from "../../lib/files"
import { formatValue } from "../../lib/formatValue"

export type DatasetGridColumnMeta = {
  type: string
  numeric: boolean
}

type Row = Record<string, unknown>

type DatasetTableGridProps = {
  columns: string[]
  columnMeta: Map<string, DatasetGridColumnMeta>
  rows: Row[]
  offset: number
  isLoading: boolean
  isError: boolean
  emptyDescription?: string
}

function defaultColumnWidth(meta: DatasetGridColumnMeta | undefined): number {
  if (!meta) return 200
  switch (meta.type.replace("?", "")) {
    case "boolean":
      return 110
    case "int64":
    case "float64":
    case "decimal":
      return 140
    case "date":
      return 150
    case "timestamp":
      return 200
    case "json":
    case "fileRef":
      return 280
    default:
      return 220
  }
}

function isNullish(value: unknown): boolean {
  return value === null || value === undefined
}

function prettyValue(value: unknown): string {
  if (value === undefined) return "undefined"
  if (value === null) return "null"
  if (typeof value === "object") return JSON.stringify(value, null, 2)
  return String(value)
}

export function DatasetTableGrid({
  columns,
  columnMeta,
  rows,
  offset,
  isLoading,
  isError,
  emptyDescription,
}: DatasetTableGridProps) {
  const [expandedCell, setExpandedCell] = useState<{
    column: string
    rowNumber: number
    value: unknown
  } | null>(null)

  const gridColumns = useMemo<DataTableColumn<Row>[]>(
    () =>
      columns.map((name) => {
        const meta = columnMeta.get(name)
        return {
          id: name,
          header: name,
          typeLabel: meta?.type,
          accessor: (row) => row[name],
          align: meta?.numeric ? "right" : "left",
          size: defaultColumnWidth(meta),
          cell: (value) => {
            const nullish = isNullish(value)
            if (isFileRefValue(value)) {
              return <FileRefCell fileRef={value} />
            }

            const text = nullish ? "null" : formatValue(value)
            return (
              <span
                title={text}
                className={cn(
                  "block truncate font-mono",
                  nullish ? "italic text-muted-foreground/50" : "text-foreground"
                )}
              >
                {text}
              </span>
            )
          },
        }
      }),
    [columns, columnMeta]
  )

  if (isError) {
    return (
      <GridMessage
        title="Rows unavailable"
        description="Could not load the selected dataset version."
      />
    )
  }

  if (columns.length === 0) {
    return <GridMessage title="No schema" description="This dataset has no declared columns." />
  }

  return (
    <>
      <DataTable
        columns={gridColumns}
        data={rows}
        showRowIndex
        rowIndexOffset={offset}
        isLoading={isLoading}
        className="scrollbar-auto-hide"
        empty={
          <EmptyState
            icon={<Database className="h-10 w-10" />}
            title="No rows"
            description={emptyDescription ?? "This dataset version does not have preview rows."}
          />
        }
        onCellClick={({ columnId, value, rowIndex }) =>
          setExpandedCell({ column: columnId, rowNumber: offset + rowIndex + 1, value })
        }
      />
      <CellDetailDialog cell={expandedCell} onClose={() => setExpandedCell(null)} />
    </>
  )
}

function CellDetailDialog({
  cell,
  onClose,
}: {
  cell: { column: string; rowNumber: number; value: unknown } | null
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)
  const text = cell ? prettyValue(cell.value) : ""
  const fileRef = cell && isFileRefValue(cell.value) ? cell.value : null

  const handleCopy = async () => {
    try {
      await navigator.clipboard?.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard may be unavailable (insecure context / permissions).
    }
  }

  return (
    <Dialog
      open={cell !== null}
      onOpenChange={(open) => {
        if (!open) {
          setCopied(false)
          onClose()
        }
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">{cell?.column}</DialogTitle>
          <DialogDescription>Row {cell?.rowNumber}</DialogDescription>
        </DialogHeader>
        {fileRef ? (
          <FileRefDetail fileRef={fileRef} />
        ) : (
          <pre className="max-h-[55vh] overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed text-foreground scrollbar-auto-hide">
            {text}
          </pre>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={handleCopy}>
            {copied ? <Check className="text-success" /> : <Copy />}
            {copied ? "Copied" : "Copy value"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function FileRefCell({ fileRef }: { fileRef: FileRefValue }) {
  const fileName = fileRefName(fileRef)
  const mediaLabel = fileMediaLabel(fileRef.mediaType, fileName)
  const summary = `${fileName} · ${mediaLabel} · ${formatFileSize(fileRef.sizeBytes)}`

  return (
    <span className="block truncate font-mono text-foreground" title={summary}>
      {fileName}
    </span>
  )
}

function FileRefDetail({ fileRef }: { fileRef: FileRefValue }) {
  const fileName = fileRefName(fileRef)
  const mediaLabel = fileMediaLabel(fileRef.mediaType, fileName)

  const rows = [
    ["File name", fileName],
    ["Media type", fileRef.mediaType ?? mediaLabel],
    ["Size", formatFileSize(fileRef.sizeBytes)],
    ["Blob ID", fileRef.blobId],
    ["Digest", fileRef.digest],
    ["Logical path", fileRef.logicalPath],
  ].filter((row): row is [string, string] => typeof row[1] === "string" && row[1].length > 0)

  return (
    <div className="space-y-4">
      <div className="min-w-0 rounded-md border border-border bg-muted/30 p-3">
        <p className="truncate font-mono text-sm text-foreground" title={fileName}>
          {fileName}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {mediaLabel} · {formatFileSize(fileRef.sizeBytes)}
        </p>
      </div>
      <dl className="grid gap-2 rounded-md border border-border bg-background p-3 text-xs">
        {rows.map(([label, value]) => (
          <div key={label} className="grid gap-1 sm:grid-cols-[7rem_minmax(0,1fr)]">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-all font-mono text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function GridMessage({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <EmptyState
        icon={<Database className="h-10 w-10" />}
        title={title}
        description={description}
      />
    </div>
  )
}
