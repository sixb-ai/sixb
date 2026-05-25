import type {
  GetDatasetResponse,
  ListDatasetRowsResponse,
  ListDatasetsResponse,
} from "@pario/client"
import {
  getDatasetOptions,
  listDatasetRowsOptions,
  listDatasetsOptions,
  listDatasetVersionsOptions,
} from "@pario/client/hooks"
import {
  Button,
  Card,
  CollectionCardButton,
  CollectionCardGrid,
  CollectionHeader,
  CollectionViewToggle,
  EmptyState,
  Input,
  Label,
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
} from "@pario/ui/components"
import { cn } from "@pario/ui/lib/utils"
import { useQuery } from "@tanstack/react-query"
import {
  ChevronLeft,
  ChevronRight,
  Clock3,
  Columns3,
  Database,
  GitBranch,
  Loader2,
  Search,
} from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { formatValue } from "../lib/formatValue"
import { humanizeIdentifier } from "../lib/labels"
import { formatRelativeTime } from "../lib/time"
import { getCollectionViewStyle, setCollectionViewStyle } from "../lib/userPreferences"

type Dataset = ListDatasetsResponse[number] | GetDatasetResponse
type DatasetListItem = ListDatasetsResponse[number]
type DatasetVersion = NonNullable<GetDatasetResponse["latestVersion"]>
type DatasetColumn = Dataset["schema"]["columns"][number]
type DatasetListViewStyle = "cards" | "table"

const datasetListViewOptions = [
  { value: "cards", label: "Cards" },
  { value: "table", label: "Table" },
] as const

const rowPreviewLimit = 50
const emptyDatasetVersions: DatasetVersion[] = []

function datasetName(dataset: Pick<Dataset, "id">): string {
  return humanizeIdentifier(dataset.id)
}

function formatCount(value?: number): string {
  return typeof value === "number" ? value.toLocaleString() : "-"
}

function formatBytes(value?: number): string {
  if (typeof value !== "number") return "-"
  if (value === 0) return "0 B"

  const units = ["B", "KB", "MB", "GB", "TB"]
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  const scaled = value / 1024 ** index
  const precision = scaled >= 10 || index === 0 ? 0 : 1

  return `${scaled.toFixed(precision)} ${units[index]}`
}

function datasetSummary(dataset: Dataset): string {
  const parts = [
    dataset.materialized ? "Materialized dataset" : "Declared dataset",
    `${dataset.schema.columns.length} column${dataset.schema.columns.length === 1 ? "" : "s"}`,
  ]

  if (dataset.latestVersion?.rowCount !== undefined) {
    parts.push(`${formatCount(dataset.latestVersion.rowCount)} rows`)
  }

  return parts.join(" · ")
}

function sourceCount(dataset: Dataset): number {
  return dataset.syncIds.length + dataset.sourcePipelineIds.length + dataset.projectionIds.length
}

function consumerCount(dataset: Dataset): number {
  return dataset.targetPipelineIds.length
}

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

function DetailSurface({
  title,
  actions,
  children,
  className,
}: {
  title: string
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section
      className={cn(
        "min-w-0 max-w-full overflow-hidden rounded-lg border border-border bg-card px-5 py-5 sm:px-6",
        className
      )}
    >
      <div className="mb-4 flex min-w-0 items-center justify-between gap-4">
        <h2 className="text-[15px] font-semibold tracking-tight text-foreground">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  )
}

function MetricTile({
  label,
  value,
  detail,
}: {
  label: string
  value: React.ReactNode
  detail?: React.ReactNode
}) {
  return (
    <div className="min-w-0 px-5 py-4">
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <div className="mt-2 min-w-0 truncate text-2xl font-semibold tracking-tight tabular-nums text-foreground">
        {value}
      </div>
      {detail && (
        <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{detail}</div>
      )}
    </div>
  )
}

function DatasetMetrics({
  dataset,
  selectedVersion,
}: {
  dataset: Dataset
  selectedVersion: DatasetVersion | null
}) {
  const versionMode = selectedVersion?.mode
  const versionValue = versionMode
    ? versionMode.charAt(0).toUpperCase() + versionMode.slice(1)
    : "—"

  return (
    <div className="grid overflow-hidden rounded-lg border border-border bg-card sm:grid-cols-2 sm:divide-x sm:divide-y-0 sm:divide-border/40 lg:grid-cols-4">
      <MetricTile
        label="Version"
        value={versionValue}
        detail={selectedVersion?.versionId ?? undefined}
      />
      <MetricTile label="Rows" value={formatCount(selectedVersion?.rowCount)} />
      <MetricTile
        label="Columns"
        value={selectedVersion?.schema.columns.length ?? dataset.schema.columns.length}
        detail={
          dataset.partitionBy?.length
            ? `Partitioned by ${dataset.partitionBy.join(", ")}`
            : undefined
        }
      />
      <MetricTile
        label="Storage"
        value={formatBytes(selectedVersion?.sizeBytes)}
        detail={dataset.materialized ? "Materialized" : "Declared only"}
      />
    </div>
  )
}

function VersionSelect({
  versions,
  selectedVersionId,
  onSelect,
}: {
  versions: DatasetVersion[]
  selectedVersionId: string | null
  onSelect: (versionId: string) => void
}) {
  if (versions.length === 0) return null

  return (
    <div className="flex min-w-0 items-center gap-2">
      <Label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Version
      </Label>
      <Select value={selectedVersionId ?? undefined} onValueChange={onSelect}>
        <SelectTrigger className="h-9 max-w-[280px] font-mono text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {versions.map((version) => (
            <SelectItem key={version.versionId} value={version.versionId} className="font-mono">
              {version.versionId}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function SchemaTable({
  columns,
  partitionBy,
}: {
  columns: DatasetColumn[]
  partitionBy?: string[]
}) {
  if (columns.length === 0) {
    return (
      <EmptyState
        icon={<Columns3 className="h-10 w-10" />}
        title="No schema"
        description="This dataset has no declared columns."
        className="py-8"
      />
    )
  }

  const partitionColumns = new Set(partitionBy ?? [])

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-border text-[11px] uppercase tracking-wider text-muted-foreground">
            <th className="pb-2.5 font-medium">Column</th>
            <th className="px-3 pb-2.5 font-medium">Type</th>
            <th className="pb-2.5 text-right font-medium">Role</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/30">
          {columns.map((column) => (
            <tr key={column.name}>
              <td className="py-3 pr-4 font-mono text-xs text-foreground">{column.name}</td>
              <td className="px-3 py-3 font-mono text-xs text-muted-foreground">
                {column.type}
                {column.nullable ? "?" : ""}
              </td>
              <td className="py-3 text-right">
                {partitionColumns.has(column.name) ? (
                  <span className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-foreground">
                    Partition
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">Column</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function RowPreview({
  rows,
  isLoading,
  isError,
  offset,
  onPrevious,
  onNext,
}: {
  rows: ListDatasetRowsResponse | undefined
  isLoading: boolean
  isError: boolean
  offset: number
  onPrevious: () => void
  onNext: () => void
}) {
  if (isLoading) {
    return (
      <div className="py-10">
        <div className="flex items-center gap-3 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Loading rows...</span>
        </div>
      </div>
    )
  }

  if (isError) {
    return (
      <EmptyState
        icon={<Database className="h-10 w-10" />}
        title="Rows unavailable"
        description="Could not load the selected dataset version."
        className="py-8"
      />
    )
  }

  if (!rows || rows.rows.length === 0) {
    return (
      <EmptyState
        icon={<Database className="h-10 w-10" />}
        title="No rows"
        description="This dataset version does not have preview rows."
        className="py-8"
      />
    )
  }

  const rangeStart = offset + 1
  const rangeEnd = offset + rows.rows.length
  const rangeLabel =
    typeof rows.total === "number"
      ? `${rangeStart}-${rangeEnd} of ${formatCount(rows.total)}`
      : `${rangeStart}-${rangeEnd}`

  return (
    <div className="-mx-5 min-w-0 border-y border-border sm:-mx-6">
      <div className="max-h-[520px] overflow-auto">
        <Table className="min-w-[720px] table-fixed">
          <TableHeader className="sticky top-0 z-10">
            <TableRow>
              {rows.columns.map((column, columnIndex) => (
                <TableHead
                  key={column}
                  className={cn(
                    "w-48 font-mono normal-case",
                    columnIndex === 0 && "pl-5 sm:pl-6",
                    columnIndex === rows.columns.length - 1 && "pr-5 sm:pr-6"
                  )}
                >
                  <span className="block truncate">{column}</span>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.rows.map((row, index) => (
              <TableRow key={`${rows.offset}:${index}`} className="align-top">
                {rows.columns.map((column, columnIndex) => (
                  <TableCell
                    key={column}
                    className={cn(
                      columnIndex === 0 && "pl-5 sm:pl-6",
                      columnIndex === rows.columns.length - 1 && "pr-5 sm:pr-6"
                    )}
                  >
                    <span className="block max-h-16 overflow-hidden break-words font-mono text-xs text-foreground">
                      {formatValue(row[column])}
                    </span>
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="mt-3 flex flex-col gap-2 px-5 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <span className="tabular-nums">{rangeLabel}</span>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onPrevious}
            disabled={offset === 0}
            aria-label="Previous page"
          >
            <ChevronLeft />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onNext}
            disabled={!rows.hasMore}
            aria-label="Next page"
          >
            <ChevronRight />
          </Button>
        </div>
      </div>
    </div>
  )
}

function VersionsTable({
  versions,
  selectedVersionId,
  onSelect,
}: {
  versions: DatasetVersion[]
  selectedVersionId: string | null
  onSelect: (versionId: string) => void
}) {
  if (versions.length === 0) {
    return (
      <EmptyState
        icon={<Clock3 className="h-10 w-10" />}
        title="No versions"
        description="Committed dataset versions will appear here."
        className="py-8"
      />
    )
  }

  return (
    <div className="-mx-2 max-h-[420px] overflow-auto">
      <ul className="divide-y divide-border/30">
        {versions.map((version) => {
          const selected = version.versionId === selectedVersionId

          return (
            <li key={version.versionId}>
              <Button
                type="button"
                variant="ghost"
                onClick={() => onSelect(version.versionId)}
                className={cn(
                  "h-auto w-full justify-start py-2.5 text-left",
                  selected && "bg-muted"
                )}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-xs text-foreground">{version.versionId}</p>
                  <p className="mt-1 truncate text-[11px] font-normal text-muted-foreground">
                    {version.producer
                      ? `${version.producer.kind}${
                          version.producer.id ? ` / ${version.producer.id}` : ""
                        }`
                      : formatRelativeTime(version.createdAt)}
                  </p>
                </div>
              </Button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function DetailField({
  label,
  value,
  mono,
}: {
  label: string
  value: React.ReactNode
  mono?: boolean
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className={cn("mt-1 break-words text-sm text-foreground", mono && "font-mono text-xs")}>
        {value}
      </dd>
    </div>
  )
}

function ReferenceList({
  label,
  ids,
  onSelect,
}: {
  label: string
  ids: string[]
  onSelect?: (id: string) => void
}) {
  if (ids.length === 0) return null

  return (
    <div className="min-w-0">
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <div className="mt-2 flex flex-col">
        {ids.map((id) => {
          const content = (
            <>
              <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{id}</span>
            </>
          )

          if (onSelect) {
            return (
              <Button
                key={id}
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onSelect(id)}
                className="-mx-2 max-w-full justify-start font-mono text-xs text-foreground"
              >
                {content}
              </Button>
            )
          }

          return (
            <span
              key={id}
              className="inline-flex max-w-full items-center gap-2 px-0 py-1.5 font-mono text-xs text-foreground"
            >
              {content}
            </span>
          )
        })}
      </div>
    </div>
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

export function DatasetDetailPage() {
  const { datasetId = "" } = useParams()
  const navigate = useNavigate()
  const decodedDatasetId = decodeURIComponent(datasetId)
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null)
  const [rowsOffset, setRowsOffset] = useState(0)

  const datasetQuery = useQuery({
    ...getDatasetOptions({
      path: { datasetId: decodedDatasetId },
    }),
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
    versions.find((version) => version.versionId === selectedVersionId) ??
    (dataset?.latestVersion?.versionId === selectedVersionId ? dataset.latestVersion : null)

  const handleSelectVersion = (versionId: string) => {
    setSelectedVersionId(versionId)
    setRowsOffset(0)
  }

  const rowsQuery = useQuery({
    ...listDatasetRowsOptions({
      path: { datasetId: decodedDatasetId },
      query: {
        versionId: selectedVersionId ?? undefined,
        limit: String(rowPreviewLimit),
        offset: String(rowsOffset),
      },
    }),
    enabled: decodedDatasetId.length > 0 && selectedVersionId !== null,
  })

  if (datasetQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center py-24">
        <div className="flex items-center gap-3 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Loading dataset...</span>
        </div>
      </div>
    )
  }

  if (datasetQuery.isError || !dataset) {
    return (
      <div className="mx-auto w-full max-w-2xl space-y-4">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => navigate("/datasets")}
          className="-ml-2 self-start text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft />
          Datasets
        </Button>
        <div className="rounded-lg border border-border bg-card p-8">
          <EmptyState
            icon={<Database className="h-10 w-10" />}
            title="Dataset not found"
            description="This dataset is not registered in the active Pario runtime."
          />
        </div>
      </div>
    )
  }

  const schemaColumns = selectedVersion?.schema.columns ?? dataset.schema.columns

  return (
    <div className="mx-auto w-full max-w-6xl min-w-0 space-y-4 overflow-hidden">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => navigate("/datasets")}
        className="-ml-2 self-start text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft />
        Datasets
      </Button>

      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-[32px]">
            {datasetName(dataset)}
          </h1>
          <p className="mt-1.5 break-all font-mono text-xs text-muted-foreground">{dataset.id}</p>
          <p className="mt-2 text-sm text-muted-foreground">{datasetSummary(dataset)}</p>
        </div>
        <VersionSelect
          versions={versions}
          selectedVersionId={selectedVersionId}
          onSelect={handleSelectVersion}
        />
      </header>

      <DatasetMetrics dataset={dataset} selectedVersion={selectedVersion} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4">
          <DetailSurface title="Rows">
            {selectedVersion ? (
              <RowPreview
                rows={rowsQuery.data}
                isLoading={rowsQuery.isLoading}
                isError={rowsQuery.isError}
                offset={rowsOffset}
                onPrevious={() => setRowsOffset((offset) => Math.max(0, offset - rowPreviewLimit))}
                onNext={() => setRowsOffset((offset) => offset + rowPreviewLimit)}
              />
            ) : (
              <EmptyState
                icon={<Database className="h-10 w-10" />}
                title="No version selected"
                description="Rows are available after the dataset has a committed version."
                className="py-8"
              />
            )}
          </DetailSurface>

          <DetailSurface title="Schema">
            <SchemaTable columns={schemaColumns} partitionBy={dataset.partitionBy} />
          </DetailSurface>
        </div>

        <aside className="space-y-4">
          <DetailSurface title="Details">
            <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-1">
              <DetailField
                label="Type"
                value={dataset.materialized ? "Materialized" : "Declared"}
              />
              <DetailField label="Description" value={dataset.description ?? "No description"} />
            </dl>
          </DetailSurface>

          <DetailSurface title="Versions">
            {versionsQuery.isLoading ? (
              <div className="py-10">
                <div className="flex items-center gap-3 text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  <span className="text-sm">Loading versions...</span>
                </div>
              </div>
            ) : versionsQuery.isError ? (
              <EmptyState
                icon={<Clock3 className="h-10 w-10" />}
                title="Versions unavailable"
                description="Could not load dataset version history."
                className="py-8"
              />
            ) : (
              <VersionsTable
                versions={versions}
                selectedVersionId={selectedVersionId}
                onSelect={handleSelectVersion}
              />
            )}
          </DetailSurface>

          {sourceCount(dataset) + consumerCount(dataset) > 0 && (
            <DetailSurface title="References">
              <div className="space-y-5">
                <ReferenceList
                  label="Syncs"
                  ids={dataset.syncIds}
                  onSelect={(syncId) => navigate(`/syncs/${encodeURIComponent(syncId)}`)}
                />
                <ReferenceList label="Source pipelines" ids={dataset.sourcePipelineIds} />
                <ReferenceList label="Target pipelines" ids={dataset.targetPipelineIds} />
                <ReferenceList label="Projections" ids={dataset.projectionIds} />
              </div>
            </DetailSurface>
          )}
        </aside>
      </div>
    </div>
  )
}
