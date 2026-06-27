import type { ListDatasetsResponse, ListDatasetVersionsResponse } from "@sixb/client"
import {
  getDatasetOptions,
  listDatasetRowsOptions,
  listDatasetsOptions,
  listDatasetVersionsOptions,
} from "@sixb/client/hooks"
import {
  Badge,
  Button,
  Card,
  CollectionCardButton,
  CollectionCardGrid,
  CollectionHeader,
  CollectionViewToggle,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { useQuery } from "@tanstack/react-query"
import {
  ChevronLeft,
  ChevronRight,
  Columns3,
  Database,
  Info,
  Loader2,
  RefreshCw,
  Search,
} from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { DatasetDetails } from "../features/datasets/DatasetDetails"
import { type DatasetGridColumnMeta, DatasetTableGrid } from "../features/datasets/DatasetTableGrid"
import {
  consumerCount,
  datasetName,
  formatBytes,
  formatCount,
  isNumericColumnType,
  sourceCount,
} from "../lib/datasets"
import { formatRelativeTime } from "../lib/time"
import { getCollectionViewStyle, setCollectionViewStyle } from "../lib/userPreferences"

type DatasetListItem = ListDatasetsResponse[number]
type DatasetVersion = ListDatasetVersionsResponse["versions"][number]
type DatasetListViewStyle = "cards" | "table"

const datasetListViewOptions = [
  { value: "cards", label: "Cards" },
  { value: "table", label: "Table" },
] as const

const pageSizeOptions = ["50", "100", "250", "500", "1000"] as const
const emptyDatasetVersions: DatasetVersion[] = []
const emptyRows: Array<Record<string, unknown>> = []

function datasetSearchText(dataset: DatasetListItem): string {
  return [
    dataset.id,
    dataset.description,
    dataset.materialized ? "materialized" : "declared",
    dataset.latestVersion?.mode,
    ...dataset.schema.columns.map((column) => column.name),
    ...(dataset.partitionBy ?? []),
    ...dataset.syncIds,
    ...dataset.sourcePipelineIds,
    ...dataset.targetPipelineIds,
    ...dataset.projectionIds,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase()
}

function DatasetListCard({
  dataset,
  onSelect,
}: {
  dataset: DatasetListItem
  onSelect: () => void
}) {
  const rowCount = dataset.latestVersion?.rowCount
  const columnCount = dataset.schema.columns.length

  return (
    <CollectionCardButton onClick={onSelect}>
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Database className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{datasetName(dataset)}</p>
        <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{dataset.id}</p>
      </div>
      <div className="hidden shrink-0 items-baseline gap-3 text-xs text-muted-foreground sm:flex">
        <span className="tabular-nums">
          {typeof rowCount === "number" ? `${formatCount(rowCount)} rows` : "No rows"}
        </span>
        <span className="text-border">·</span>
        <span className="tabular-nums">
          {columnCount} {columnCount === 1 ? "col" : "cols"}
        </span>
      </div>
    </CollectionCardButton>
  )
}

function DatasetTableView({
  datasets,
  onSelect,
}: {
  datasets: ListDatasetsResponse
  onSelect: (datasetId: string) => void
}) {
  return (
    <Card className="overflow-hidden p-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Dataset</TableHead>
            <TableHead className="hidden text-right md:table-cell">Rows</TableHead>
            <TableHead className="text-right">Columns</TableHead>
            <TableHead className="hidden text-right lg:table-cell">Refs</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {datasets.map((dataset) => (
            <TableRow
              key={dataset.id}
              onClick={() => onSelect(dataset.id)}
              className="cursor-pointer"
            >
              <TableCell>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {datasetName(dataset)}
                  </p>
                  <p className="truncate font-mono text-[11px] text-muted-foreground">
                    {dataset.id}
                  </p>
                </div>
              </TableCell>
              <TableCell className="hidden text-right text-sm tabular-nums text-foreground md:table-cell">
                {formatCount(dataset.latestVersion?.rowCount)}
              </TableCell>
              <TableCell className="text-right text-sm tabular-nums text-foreground">
                {dataset.schema.columns.length}
              </TableCell>
              <TableCell className="hidden text-right text-sm tabular-nums text-muted-foreground lg:table-cell">
                {sourceCount(dataset) + consumerCount(dataset)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  )
}

export function DatasetsPage() {
  const { data: datasets = [], isLoading, isError } = useQuery(listDatasetsOptions())
  const navigate = useNavigate()
  const [searchQuery, setSearchQuery] = useState("")
  const [viewStyle, setViewStyle] = useState<DatasetListViewStyle>(() =>
    getCollectionViewStyle("datasets", ["cards", "table"], "cards")
  )

  const filteredDatasets = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return datasets
    return datasets.filter((dataset) => datasetSearchText(dataset).includes(query))
  }, [datasets, searchQuery])

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center py-24">
        <div className="flex items-center gap-3 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Loading datasets...</span>
        </div>
      </div>
    )
  }

  if (isError) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="w-full max-w-md rounded-lg border border-border bg-card p-6">
          <EmptyState
            icon={<Database className="h-10 w-10" />}
            title="Datasets unavailable"
            description="Could not load dataset metadata."
          />
        </div>
      </div>
    )
  }

  const handleSelectDataset = (datasetId: string) => {
    navigate(`/datasets/${encodeURIComponent(datasetId)}`)
  }

  return (
    <div className="mx-auto w-full max-w-5xl">
      <CollectionHeader
        title="Datasets"
        count={filteredDatasets.length}
        actions={
          datasets.length > 0 ? (
            <CollectionViewToggle
              value={viewStyle}
              options={datasetListViewOptions}
              onChange={(style) => {
                setViewStyle(style)
                setCollectionViewStyle("datasets", style)
              }}
            />
          ) : null
        }
      />

      {datasets.length > 0 && (
        <div className="relative mt-2">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search datasets, columns, syncs, or pipelines..."
            className="pl-9"
          />
        </div>
      )}

      <div className="mt-4">
        {datasets.length === 0 ? (
          <EmptyState
            icon={<Database className="h-10 w-10" />}
            title="No datasets"
            description="Registered datasets will appear here."
          />
        ) : filteredDatasets.length === 0 ? (
          <EmptyState
            icon={<Search className="h-9 w-9" />}
            title="No results"
            description="Try another search."
            className="py-12"
          />
        ) : viewStyle === "table" ? (
          <DatasetTableView datasets={filteredDatasets} onSelect={handleSelectDataset} />
        ) : (
          <CollectionCardGrid>
            {filteredDatasets.map((dataset) => (
              <DatasetListCard
                key={dataset.id}
                dataset={dataset}
                onSelect={() => handleSelectDataset(dataset.id)}
              />
            ))}
          </CollectionCardGrid>
        )}
      </div>
    </div>
  )
}

function ColumnsMenu({
  columns,
  hiddenColumns,
  onToggle,
  onShowAll,
}: {
  columns: string[]
  hiddenColumns: Set<string>
  onToggle: (column: string) => void
  onShowAll: () => void
}) {
  const visibleCount = columns.length - hiddenColumns.size

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs">
          <Columns3 className="size-3.5" />
          Columns
          {hiddenColumns.size > 0 ? (
            <span className="tabular-nums text-muted-foreground">
              {visibleCount}/{columns.length}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[60vh] w-56 overflow-auto">
        <div className="flex items-center justify-between px-2 py-1">
          <DropdownMenuLabel className="p-0">Columns</DropdownMenuLabel>
          {hiddenColumns.size > 0 ? (
            <button
              type="button"
              onClick={onShowAll}
              className="text-[11px] text-muted-foreground hover:text-foreground"
            >
              Show all
            </button>
          ) : null}
        </div>
        <DropdownMenuSeparator />
        {columns.map((column) => (
          <DropdownMenuCheckboxItem
            key={column}
            checked={!hiddenColumns.has(column)}
            onCheckedChange={() => onToggle(column)}
            onSelect={(event) => event.preventDefault()}
            className="font-mono text-xs"
          >
            <span className="truncate">{column}</span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function DatasetDetailPage() {
  const { datasetId = "" } = useParams()
  const navigate = useNavigate()
  const decodedDatasetId = decodeURIComponent(datasetId)
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null)
  const [rowsOffset, setRowsOffset] = useState(0)
  const [quickFilter, setQuickFilter] = useState("")
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(() => new Set())
  const [pageSize, setPageSize] = useState<number>(() =>
    Number(getCollectionViewStyle("dataset-page-size", pageSizeOptions, "100"))
  )

  // Different dataset → drop column/filter state that only made sense before.
  // biome-ignore lint/correctness/useExhaustiveDependencies: effect is keyed on the dataset id to reset state on navigation, not because the body reads it
  useEffect(() => {
    setHiddenColumns(new Set())
    setQuickFilter("")
    setRowsOffset(0)
  }, [decodedDatasetId])

  const datasetQuery = useQuery({
    ...getDatasetOptions({ path: { datasetId: decodedDatasetId } }),
    enabled: decodedDatasetId.length > 0,
  })

  const versionsQuery = useQuery({
    ...listDatasetVersionsOptions({
      path: { datasetId: decodedDatasetId },
      query: { limit: "50" },
    }),
    enabled: decodedDatasetId.length > 0,
  })

  const dataset = datasetQuery.data
  const versions = versionsQuery.data?.versions ?? emptyDatasetVersions

  useEffect(() => {
    const preferredVersionId = dataset?.latestVersion?.versionId ?? versions[0]?.versionId ?? null
    if (selectedVersionId === preferredVersionId) return

    const versionIds = new Set(versions.map((version) => version.versionId))
    const selectedVersionAvailable =
      selectedVersionId !== null && (versionIds.size === 0 || versionIds.has(selectedVersionId))

    if (!selectedVersionAvailable) {
      setSelectedVersionId(preferredVersionId)
      setRowsOffset(0)
    }
  }, [dataset?.latestVersion?.versionId, selectedVersionId, versions])

  const selectedVersion =
    versions.find((version) => version.versionId === selectedVersionId) ?? null

  const handleSelectVersion = (versionId: string) => {
    setSelectedVersionId(versionId)
    setRowsOffset(0)
  }

  const rowsQuery = useQuery({
    ...listDatasetRowsOptions({
      path: { datasetId: decodedDatasetId },
      query: {
        versionId: selectedVersionId ?? undefined,
        limit: String(pageSize),
        offset: String(rowsOffset),
      },
    }),
    enabled: decodedDatasetId.length > 0 && selectedVersionId !== null,
  })

  const rowsData = rowsQuery.data

  // Prefer the full version metadata; fall back to the version embedded in the
  // rows response so stats render before the versions list resolves.
  const schemaColumns =
    selectedVersion?.schema.columns ??
    rowsData?.version?.schema.columns ??
    dataset?.schema.columns ??
    []

  const columnMeta = useMemo(() => {
    const map = new Map<string, DatasetGridColumnMeta>()
    for (const column of schemaColumns) {
      map.set(column.name, {
        type: `${column.type}${column.nullable ? "?" : ""}`,
        numeric: isNumericColumnType(column.type),
      })
    }
    return map
  }, [schemaColumns])

  const allColumns = rowsData?.columns ?? schemaColumns.map((column) => column.name)

  const visibleColumns = useMemo(
    () => allColumns.filter((column) => !hiddenColumns.has(column)),
    [allColumns, hiddenColumns]
  )

  const rawRows = rowsData?.rows ?? emptyRows

  const filteredRows = useMemo(() => {
    const query = quickFilter.trim().toLowerCase()
    if (!query) return rawRows
    return rawRows.filter((row) =>
      visibleColumns.some((column) => {
        const value = row[column]
        if (value === null || value === undefined) return false
        return String(typeof value === "object" ? JSON.stringify(value) : value)
          .toLowerCase()
          .includes(query)
      })
    )
  }, [rawRows, quickFilter, visibleColumns])

  const toggleColumn = (column: string) => {
    setHiddenColumns((previous) => {
      const next = new Set(previous)
      if (next.has(column)) {
        next.delete(column)
      } else if (allColumns.length - next.size > 1) {
        // Keep at least one column visible.
        next.add(column)
      }
      return next
    })
  }

  const handlePageSizeChange = (next: string) => {
    setPageSize(Number(next))
    setRowsOffset(0)
    setCollectionViewStyle("dataset-page-size", next)
  }

  const handleRefresh = () => {
    datasetQuery.refetch()
    versionsQuery.refetch()
    if (selectedVersionId !== null) rowsQuery.refetch()
  }

  if (datasetQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex items-center gap-3 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Loading dataset...</span>
        </div>
      </div>
    )
  }

  if (datasetQuery.isError || !dataset) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b border-border px-4 py-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => navigate("/datasets")}
            className="-ml-2 text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft />
            Datasets
          </Button>
        </div>
        <div className="flex flex-1 items-center justify-center p-6">
          <EmptyState
            icon={<Database className="h-10 w-10" />}
            title="Dataset not found"
            description="This dataset is not registered in the active Sixb runtime."
          />
        </div>
      </div>
    )
  }

  const rowCount = selectedVersion?.rowCount ?? rowsData?.version?.rowCount ?? rowsData?.total
  const sizeBytes = selectedVersion?.sizeBytes ?? rowsData?.version?.sizeBytes
  const rangeStart = rawRows.length > 0 ? rowsOffset + 1 : 0
  const rangeEnd = rowsOffset + rawRows.length
  const totalRows = rowsData?.total ?? rowCount
  const rangeLabel =
    typeof totalRows === "number"
      ? `${rangeStart.toLocaleString()}–${rangeEnd.toLocaleString()} of ${formatCount(totalRows)}`
      : `${rangeStart.toLocaleString()}–${rangeEnd.toLocaleString()}`
  const filterActive = quickFilter.trim().length > 0
  const noCommittedVersions = selectedVersionId === null && versions.length === 0

  const versionSummary = {
    versionId:
      selectedVersion?.versionId ?? rowsData?.version?.versionId ?? selectedVersionId ?? undefined,
    rowCount,
    sizeBytes,
    createdAt: selectedVersion?.createdAt ?? rowsData?.version?.createdAt,
    mode: selectedVersion?.mode ?? rowsData?.version?.mode,
    producer: selectedVersion?.producer ?? rowsData?.version?.producer,
  }

  const latestVersionId = dataset.latestVersion?.versionId
  const isLatestVersion = selectedVersionId != null && selectedVersionId === latestVersionId
  const versionLabel = isLatestVersion
    ? "Latest"
    : selectedVersion?.createdAt
      ? formatRelativeTime(selectedVersion.createdAt)
      : "Version"

  return (
    <div className="flex h-full w-full min-w-0 flex-col overflow-hidden">
      <header className="flex shrink-0 items-start gap-2 border-b border-border px-3 py-3 sm:px-4">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => navigate("/datasets")}
          aria-label="Back to datasets"
          className="-ml-1 shrink-0 text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft />
        </Button>

        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <h1 className="min-w-0 truncate text-[15px] font-semibold tracking-tight text-foreground">
              {datasetName(dataset)}
            </h1>
            <Badge variant="secondary" className="h-5 shrink-0 px-1.5 text-[10px] font-normal">
              {dataset.materialized ? "Materialized" : "Declared"}
            </Badge>
          </div>
          <p className="truncate text-[11px] text-muted-foreground">
            <span className="font-mono">{dataset.id}</span>
            <span className="hidden sm:inline">
              {" · "}
              {[
                versionSummary.mode,
                `${formatCount(rowCount)} rows`,
                `${schemaColumns.length} cols`,
                formatBytes(sizeBytes),
                versionSummary.createdAt
                  ? `updated ${formatRelativeTime(versionSummary.createdAt)}`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </p>
        </div>

        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 shrink-0 gap-1.5 self-center px-2 text-xs text-muted-foreground hover:text-foreground"
            >
              <Info className="size-3.5" />
              <span className="hidden sm:inline">Details</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80">
            <DatasetDetails
              dataset={dataset}
              columnCount={schemaColumns.length}
              versionSummary={versionSummary}
              onNavigate={(path) => navigate(path)}
            />
          </PopoverContent>
        </Popover>
      </header>

      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 sm:px-4">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={quickFilter}
            onChange={(event) => setQuickFilter(event.target.value)}
            placeholder="Filter rows..."
            className="h-8 w-44 pl-8 text-xs sm:w-64"
          />
        </div>
        {filterActive ? (
          <span className="text-xs tabular-nums text-muted-foreground">
            {filteredRows.length.toLocaleString()} of {rawRows.length.toLocaleString()}
          </span>
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          {versions.length > 0 ? (
            <Select value={selectedVersionId ?? undefined} onValueChange={handleSelectVersion}>
              <SelectTrigger
                size="sm"
                className="h-8 w-[140px] text-xs"
                aria-label="Select version"
                title={selectedVersionId ?? undefined}
              >
                <span className="truncate">{versionLabel}</span>
              </SelectTrigger>
              <SelectContent position="popper" align="end" className="max-w-[320px]">
                {versions.map((version) => (
                  <SelectItem key={version.versionId} value={version.versionId} className="text-xs">
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="flex items-center gap-1.5">
                        <span className="max-w-[190px] truncate font-mono">
                          {version.versionId}
                        </span>
                        {version.versionId === latestVersionId ? (
                          <span className="shrink-0 rounded bg-muted px-1 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                            Latest
                          </span>
                        ) : null}
                      </span>
                      <span className="max-w-[210px] truncate text-[10px] text-muted-foreground">
                        {[
                          version.mode,
                          formatRelativeTime(version.createdAt),
                          typeof version.rowCount === "number"
                            ? `${formatCount(version.rowCount)} rows`
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <ColumnsMenu
            columns={allColumns}
            hiddenColumns={hiddenColumns}
            onToggle={toggleColumn}
            onShowAll={() => setHiddenColumns(new Set())}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={handleRefresh}
            aria-label="Refresh"
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className={cn(rowsQuery.isFetching && "animate-spin")} />
          </Button>
        </div>
      </div>

      <DatasetTableGrid
        key={decodedDatasetId}
        columns={visibleColumns}
        columnMeta={columnMeta}
        rows={filteredRows}
        offset={rowsOffset}
        isLoading={selectedVersionId !== null && rowsQuery.isLoading}
        isError={rowsQuery.isError}
        emptyDescription={
          noCommittedVersions
            ? "No committed versions yet. Rows appear after the dataset is materialized."
            : filterActive
              ? "No rows on this page match your filter."
              : "This dataset version does not have preview rows."
        }
      />

      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-3 py-1.5 sm:px-4">
        <span className="text-xs tabular-nums text-muted-foreground">
          {rowsOffset > 0 || rowsData?.hasMore ? rangeLabel : `${formatCount(rowCount)} rows`}
          {filterActive ? ` · ${filteredRows.length.toLocaleString()} shown` : ""}
        </span>
        <div className="flex items-center gap-2">
          <Select value={String(pageSize)} onValueChange={handlePageSizeChange}>
            <SelectTrigger size="sm" className="h-8 w-[104px] text-xs" aria-label="Rows per page">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="end">
              {pageSizeOptions.map((option) => (
                <SelectItem key={option} value={option} className="text-xs">
                  {option} rows
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex items-center">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setRowsOffset((offset) => Math.max(0, offset - pageSize))}
              disabled={rowsOffset === 0}
              aria-label="Previous page"
            >
              <ChevronLeft />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setRowsOffset((offset) => offset + pageSize)}
              disabled={!rowsData?.hasMore}
              aria-label="Next page"
            >
              <ChevronRight />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
