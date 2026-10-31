import {
  getDatasetOptions,
  listDatasetRowsOptions,
  listDatasetsOptions,
  listDatasetVersionsOptions,
} from "@sixb/client/hooks"
import { type FileRef, fileNameFor, isFileRef } from "@sixb/core/blob-storage"
import {
  Button,
  DataTable,
  type DataTableColumn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { ChevronLeft, ChevronRight, Columns3, Database, Info, Search } from "lucide-react"
import { type ReactNode, useMemo, useState } from "react"
import { Link, useParams, useSearchParams } from "react-router-dom"
import { DetailFallback, SectionPage, SectionWorkspace, WorkspaceHeader } from "../../section-page"
import {
  apiErrorMessage,
  CopyButton,
  Facts,
  humanize,
  IconTile,
  MetaDot,
  Panel,
  PanelEmpty,
  PanelRow,
  PanelSkeleton,
  Pill,
  useFormat,
  useNumbers,
} from "../../section-ui"
import { useDatasetLiveUpdates } from "./live-updates"
import { useDataMessages } from "./messages"
import { SchemaPanel } from "./schema"

const pageSize = 100
const numericTypes = new Set(["int64", "float64", "decimal"])

type Row = Record<string, unknown>

/** Console › Datasets: the project's versioned tables. */
export function ConsoleDatasetsPage() {
  const messages = useDataMessages()
  const format = useFormat()
  const numbers = useNumbers()
  useDatasetLiveUpdates()
  const datasetsQuery = useQuery({ ...listDatasetsOptions(), retry: false })
  const datasets = datasetsQuery.data ?? []

  return (
    <SectionPage
      section="console"
      page="datasets"
      title={messages.datasets.title}
      description={messages.datasets.description}
    >
      <Panel>
        {datasetsQuery.isPending ? (
          <PanelSkeleton rows={4} />
        ) : datasetsQuery.isError ? (
          <PanelEmpty
            tone="error"
            icon={Database}
            title={messages.datasets.title}
            description={apiErrorMessage(datasetsQuery.error, messages.common.loadFailed)}
          />
        ) : datasets.length === 0 ? (
          <PanelEmpty
            icon={Database}
            title={messages.datasets.emptyTitle}
            description={messages.datasets.emptyDescription}
          />
        ) : (
          datasets.map((dataset) => (
            <PanelRow
              key={dataset.id}
              href={`/console/datasets/${encodeURIComponent(dataset.id)}`}
              leading={<IconTile icon={Database} />}
              title={<span className="truncate">{dataset.id}</span>}
              meta={
                <>
                  {dataset.latestVersion?.rowCount !== undefined ? (
                    <>
                      <span className="tabular-nums">
                        {messages.common.rows(
                          dataset.latestVersion.rowCount,
                          numbers.count(dataset.latestVersion.rowCount)
                        )}
                      </span>
                      <MetaDot />
                    </>
                  ) : null}
                  <span>{messages.common.columns(dataset.schema.columns.length)}</span>
                  {dataset.latestVersion ? (
                    <>
                      <MetaDot />
                      <span>
                        {messages.datasets.updated(
                          format.relative(dataset.latestVersion.createdAt)
                        )}
                      </span>
                    </>
                  ) : null}
                </>
              }
              trailing={
                <>
                  {dataset.latestVersion ? null : (
                    <Pill tone="muted">{messages.datasets.declared}</Pill>
                  )}
                  <ChevronRight className="size-4 text-muted-foreground/60" />
                </>
              }
            />
          ))
        )}
      </Panel>
    </SectionPage>
  )
}

/** One dataset: its rows at any version, where it comes from and what reads it. */
export function ConsoleDatasetPage() {
  const datasetId = useParams().datasetId ?? ""
  // Paging, filter and hidden columns belong to one dataset; a new one starts clean.
  return <DatasetDetail key={datasetId} datasetId={datasetId} />
}

function DatasetDetail({ datasetId }: { readonly datasetId: string }) {
  const messages = useDataMessages()
  const format = useFormat()
  const numbers = useNumbers()
  const [searchParams, setSearchParams] = useSearchParams()
  const versionParam = searchParams.get("version") ?? undefined
  const [offset, setOffset] = useState(0)
  const [filter, setFilter] = useState("")
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set())
  const [cell, setCell] = useState<CellDetail | null>(null)
  useDatasetLiveUpdates({ datasetId })

  const datasetQuery = useQuery({ ...getDatasetOptions({ path: { datasetId } }), retry: false })
  const versionsQuery = useQuery({
    ...listDatasetVersionsOptions({ path: { datasetId } }),
    retry: false,
  })
  const hasVersion = Boolean(datasetQuery.data?.latestVersion)
  const rowsQuery = useQuery({
    ...listDatasetRowsOptions({
      path: { datasetId },
      query: { versionId: versionParam, limit: String(pageSize), offset: String(offset) },
    }),
    enabled: hasVersion,
    retry: false,
    placeholderData: keepPreviousData,
  })

  const dataset = datasetQuery.data
  const page = rowsQuery.data
  const schemaColumns = page?.version.schema.columns ?? dataset?.schema.columns ?? []
  const columnTypes = useMemo(
    () => new Map(schemaColumns.map((column) => [column.name, column.type])),
    [schemaColumns]
  )
  const allColumns = useMemo(() => datasetColumnNames(schemaColumns, page), [page, schemaColumns])
  const visibleColumns = useMemo(
    () => allColumns.filter((column) => !hidden.has(column)),
    [allColumns, hidden]
  )
  const redactions = page?.redactions
  const hiddenLabel = messages.datasets.hidden

  const gridColumns = useMemo(
    () => datasetGridColumns(visibleColumns, columnTypes, redactions, hiddenLabel),
    [visibleColumns, columnTypes, redactions, hiddenLabel]
  )

  const allRows = page?.rows ?? []
  // A row keeps its number in the version while the filter hides the rows around it.
  const rowNumbers = useMemo(
    () => new Map(allRows.map((row, index) => [row, offset + index + 1])),
    [allRows, offset]
  )
  const query = filter.trim().toLowerCase()
  const rows = query
    ? allRows.filter((row) =>
        visibleColumns.some((column) => formatCell(row[column]).toLowerCase().includes(query))
      )
    : allRows

  const back = { href: "/console/datasets", label: messages.datasets.title }

  if (!dataset) {
    return (
      <DetailFallback
        section="console"
        page="datasets"
        back={back}
        name={datasetId}
        id={datasetId}
        icon={Database}
        error={datasetQuery.error}
      />
    )
  }

  const listed = versionsQuery.data?.versions ?? []
  // A link may name a version older than the list reaches; it still gets its entry in the picker.
  const versions =
    page &&
    versionParam === page.version.versionId &&
    !listed.some((v) => v.versionId === versionParam)
      ? [...listed, page.version]
      : listed
  const shownVersion = page?.version ?? null
  const latestVersionId = dataset.latestVersion?.versionId
  const total = page?.total
  const lastRow = offset + allRows.length

  const selectVersion = (versionId: string) => {
    setOffset(0)
    setSearchParams(
      (params) => {
        if (versionId === "latest") params.delete("version")
        else params.set("version", versionId)
        return params
      },
      { replace: true }
    )
  }

  const writtenBy = [
    ...dataset.syncIds.map((id) => ({ id, href: `/console/syncs/${encodeURIComponent(id)}` })),
    ...dataset.sourcePipelineIds.map((id) => ({
      id,
      href: `/console/pipelines/${encodeURIComponent(id)}`,
    })),
  ]
  const readBy = [
    ...dataset.targetPipelineIds.map((id) => ({
      id,
      href: `/console/pipelines/${encodeURIComponent(id)}`,
    })),
    ...dataset.projectionIds.map((id) => ({
      id,
      href: `/console/projections/${encodeURIComponent(id)}`,
    })),
  ]
  const facts = [
    ...(dataset.description
      ? [{ label: messages.common.description, value: dataset.description }]
      : []),
    {
      label: messages.datasets.writtenBy,
      value: <LinkList items={writtenBy} empty={messages.datasets.nobody} />,
    },
    {
      label: messages.datasets.readBy,
      value: <LinkList items={readBy} empty={messages.datasets.nobody} />,
    },
    ...(shownVersion
      ? [
          {
            label: messages.datasets.version,
            value: (
              <span className="flex flex-col">
                <span className="font-mono text-xs break-all">{shownVersion.versionId}</span>
                <span className="text-muted-foreground">
                  {messages.common.modes[shownVersion.mode]} ·{" "}
                  {format.dateTime(shownVersion.createdAt)}
                </span>
              </span>
            ),
          },
        ]
      : []),
    ...(shownVersion?.sizeBytes !== undefined
      ? [{ label: messages.datasets.size, value: numbers.bytes(shownVersion.sizeBytes) }]
      : []),
  ]
  const rowCount = shownVersion?.rowCount ?? dataset.latestVersion?.rowCount

  return (
    <SectionWorkspace section="console" page="datasets">
      <WorkspaceHeader
        back={back}
        icon={<IconTile icon={Database} />}
        title={<span className="font-mono">{dataset.id}</span>}
        meta={
          <>
            {rowCount !== undefined ? (
              <>
                <span className="tabular-nums">
                  {messages.common.rows(rowCount, numbers.count(rowCount))}
                </span>
                <MetaDot />
              </>
            ) : null}
            <span>{messages.common.columns(dataset.schema.columns.length)}</span>
            {shownVersion ? (
              <>
                <MetaDot />
                <span className="truncate">
                  {messages.datasets.updated(format.relative(shownVersion.createdAt))}
                </span>
              </>
            ) : null}
          </>
        }
        actions={
          <>
            {versions.length > 0 ? (
              <Select value={versionParam ?? "latest"} onValueChange={selectVersion}>
                <SelectTrigger
                  size="sm"
                  className="w-36 text-xs sm:w-44"
                  aria-label={messages.datasets.version}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper" align="end" className="max-w-80">
                  <SelectItem value="latest" className="text-xs">
                    {messages.datasets.latest}
                  </SelectItem>
                  {versions.map((version) => (
                    <SelectItem
                      key={version.versionId}
                      value={version.versionId}
                      className="text-xs"
                    >
                      <span className="font-mono">{version.versionId.slice(0, 12)}</span>
                      <span className="text-muted-foreground">
                        {version.versionId === latestVersionId
                          ? messages.datasets.latest
                          : format.relative(version.createdAt)}
                        {" · "}
                        {messages.common.modes[version.mode]}
                        {version.rowCount !== undefined
                          ? ` · ${messages.common.rows(version.rowCount, numbers.count(version.rowCount))}`
                          : null}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <Sheet>
              <SheetTrigger asChild>
                <Button type="button" variant="ghost" size="sm" className="text-muted-foreground">
                  <Info />
                  <span className="hidden sm:inline">{messages.common.details}</span>
                </Button>
              </SheetTrigger>
              <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-md">
                <SheetHeader className="border-b border-border">
                  <SheetTitle className="font-mono text-sm">{dataset.id}</SheetTitle>
                  <SheetDescription>{messages.common.details}</SheetDescription>
                </SheetHeader>
                <div className="flex flex-col gap-8 p-4">
                  <Panel>
                    <Facts items={facts} />
                  </Panel>
                  <SchemaPanel dataset={dataset} />
                </div>
              </SheetContent>
            </Sheet>
          </>
        }
      />

      {!hasVersion ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <PanelEmpty
            icon={Database}
            title={messages.datasets.noVersionsTitle}
            description={messages.datasets.noVersionsDescription}
          />
        </div>
      ) : (
        <>
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3 md:px-4">
            <div className="relative w-full max-w-72">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder={messages.datasets.filter}
                className="h-8 pl-8 text-xs"
              />
            </div>
            {query ? (
              <span className="hidden text-xs whitespace-nowrap text-muted-foreground tabular-nums sm:inline">
                {messages.datasets.filtered(
                  numbers.count(rows.length),
                  numbers.count(allRows.length)
                )}
              </span>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="sm" className="ml-auto text-xs">
                  <Columns3 />
                  <span className="hidden sm:inline">
                    {hidden.size > 0
                      ? messages.datasets.columnsShown(visibleColumns.length, allColumns.length)
                      : messages.datasets.columnsMenu}
                  </span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-80 w-60 overflow-y-auto">
                <DropdownMenuLabel>{messages.datasets.columnsMenu}</DropdownMenuLabel>
                {hidden.size > 0 ? (
                  <DropdownMenuItem onSelect={() => setHidden(new Set())}>
                    {messages.datasets.showAllColumns}
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuSeparator />
                {allColumns.map((column) => (
                  <DropdownMenuCheckboxItem
                    key={column}
                    checked={!hidden.has(column)}
                    onSelect={(event) => event.preventDefault()}
                    onCheckedChange={(checked) =>
                      setHidden((current) => {
                        const next = new Set(current)
                        if (checked) next.delete(column)
                        // One column always stays.
                        else if (allColumns.length - next.size > 1) next.add(column)
                        return next
                      })
                    }
                    className="font-mono text-xs"
                  >
                    {column}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            {rowsQuery.isError ? (
              <PanelEmpty
                tone="error"
                icon={Database}
                title={messages.datasets.rowsUnavailable}
                description={apiErrorMessage(rowsQuery.error, messages.common.loadFailed)}
              />
            ) : (
              <DataTable
                columns={gridColumns}
                data={rows}
                showRowIndex
                rowNumber={(row) => rowNumbers.get(row) ?? 0}
                isLoading={rowsQuery.isPending}
                empty={
                  <PanelEmpty
                    icon={Database}
                    title={messages.datasets.noRowsTitle}
                    description={
                      query && allRows.length > 0
                        ? messages.datasets.noRowsMatch
                        : messages.datasets.noRowsDescription
                    }
                  />
                }
                onCellClick={({ columnId, value, row }) =>
                  redactions?.[columnId]
                    ? undefined
                    : setCell({
                        column: columnId,
                        rowNumber: rowNumbers.get(row) ?? 0,
                        value,
                        file:
                          columnTypes.get(columnId) === "fileRef" && isFileRef(value)
                            ? value
                            : null,
                      })
                }
              />
            )}
          </div>

          <footer className="flex h-10 shrink-0 items-center justify-between gap-3 border-t border-border px-3 md:px-4">
            <span className="text-xs text-muted-foreground tabular-nums">
              {allRows.length === 0
                ? null
                : total !== undefined
                  ? messages.datasets.range(
                      numbers.count(offset + 1),
                      numbers.count(lastRow),
                      numbers.count(total)
                    )
                  : messages.datasets.rangeOpen(numbers.count(offset + 1), numbers.count(lastRow))}
            </span>
            <div className="flex items-center">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={messages.datasets.previous}
                disabled={offset === 0 || rowsQuery.isFetching}
                onClick={() => setOffset((current) => Math.max(0, current - pageSize))}
              >
                <ChevronLeft />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={messages.datasets.next}
                disabled={!page?.hasMore || rowsQuery.isFetching}
                onClick={() => setOffset((current) => current + pageSize)}
              >
                <ChevronRight />
              </Button>
            </div>
          </footer>
        </>
      )}

      <CellDialog cell={cell} onClose={() => setCell(null)} />
    </SectionWorkspace>
  )
}

/**
 * The grid's columns, in schema order. Rows leave out the columns this person may not see and name
 * them in `redactions`; those keep their place, marked hidden, so nothing silently goes missing.
 */
export function datasetColumnNames(
  schema: readonly { readonly name: string }[],
  page?: {
    readonly columns: readonly string[]
    readonly redactions?: Readonly<Record<string, unknown>>
  }
): string[] {
  const names = schema.map((column) => column.name)
  if (!page) return names
  const read = new Set(page.columns)
  return names.filter((name) => read.has(name) || page.redactions?.[name] !== undefined)
}

/** Grid columns for a dataset's rows: typed headers, numbers to the right, withheld ones marked. */
export function datasetGridColumns(
  names: readonly string[],
  types: ReadonlyMap<string, string>,
  redactions: Readonly<Record<string, unknown>> | undefined,
  hiddenLabel: string
): DataTableColumn<Row>[] {
  return names.map((name) => {
    const type = types.get(name) ?? ""
    const redacted = Boolean(redactions?.[name])
    return {
      id: name,
      header: name,
      typeLabel: redacted ? `${type} · ${hiddenLabel}` : type,
      accessor: (row) => row[name],
      align: numericTypes.has(type) ? "right" : "left",
      size: columnWidth(type),
      cell: (value) => (
        <DatasetCell type={type} value={value} hiddenLabel={redacted ? hiddenLabel : null} />
      ),
    }
  })
}

/**
 * One grid cell. A value is a file only in a column declared `fileRef`: a `json` column holding a
 * record shaped like one holds a record.
 */
export function DatasetCell({
  type,
  value,
  hiddenLabel,
}: {
  readonly type: string
  readonly value: unknown
  /** Set when the column is withheld from this person. */
  readonly hiddenLabel: string | null
}) {
  if (hiddenLabel !== null) {
    return <span className="block truncate text-muted-foreground/60 italic">{hiddenLabel}</span>
  }
  const file = type === "fileRef" && isFileRef(value) ? value : null
  const text = file ? fileNameFor(file) : formatCell(value)
  return (
    <span
      title={text}
      className={cn(
        "block truncate font-mono",
        value === null || value === undefined
          ? "text-muted-foreground/50 italic"
          : "text-foreground"
      )}
    >
      {text}
    </span>
  )
}

function LinkList({
  items,
  empty,
}: {
  readonly items: readonly { readonly id: string; readonly href: string }[]
  readonly empty: string
}) {
  if (items.length === 0) return <span className="text-muted-foreground">{empty}</span>
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1">
      {items.map((item) => (
        <Link key={item.href} to={item.href} className="hover:underline">
          {humanize(item.id)}
        </Link>
      ))}
    </span>
  )
}

interface CellDetail {
  readonly column: string
  readonly rowNumber: number
  readonly value: unknown
  readonly file: FileRef | null
}

// Dataset rows are raw lake data, not grant-scoped objects, so a file cell shows what the file is
// and never links to its content: blob reads go through the object file route, which checks grants.
function CellDialog({
  cell,
  onClose,
}: {
  readonly cell: CellDetail | null
  readonly onClose: () => void
}) {
  const messages = useDataMessages().datasets
  const numbers = useNumbers()
  const text = cell ? prettyValue(cell.value) : ""
  const file = cell?.file ?? null
  const fileFacts: readonly { readonly label: string; readonly value: ReactNode }[] = file
    ? [
        { label: messages.fileName, value: fileNameFor(file) },
        ...(file.mediaType ? [{ label: messages.mediaType, value: file.mediaType }] : []),
        { label: messages.size, value: numbers.bytes(file.sizeBytes) },
      ]
    : []

  return (
    <Dialog open={cell !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="gap-4 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">{cell?.column}</DialogTitle>
          <DialogDescription>
            {cell ? messages.row(numbers.count(cell.rowNumber)) : null}
          </DialogDescription>
        </DialogHeader>
        {file ? (
          <div className="overflow-hidden rounded-lg border border-border">
            <Facts items={fileFacts} />
          </div>
        ) : (
          <pre className="max-h-[55dvh] overflow-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs leading-5 break-all whitespace-pre-wrap">
            {text}
          </pre>
        )}
        <div className="flex justify-end">
          <CopyButton value={text} />
        </div>
      </DialogContent>
    </Dialog>
  )
}

function columnWidth(type: string): number {
  switch (type) {
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

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "null"
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}

function prettyValue(value: unknown): string {
  if (value === undefined) return "undefined"
  if (value === null) return "null"
  if (typeof value === "object") return JSON.stringify(value, null, 2)
  return String(value)
}
