import type {
  GetProjectionResponse,
  ListProjectionRunsResponse,
  ListProjectionsResponse,
} from "@sixb/client"
import {
  getProjectionOptions,
  listProjectionRunsOptions,
  listProjectionsOptions,
} from "@sixb/client/hooks"
import {
  Badge,
  Button,
  Card,
  CollectionCardButton,
  CollectionCardGrid,
  CollectionHeader,
  CollectionViewToggle,
  EmptyState,
  Input,
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
  ArrowRight,
  Ban,
  Box,
  CheckCircle2,
  ChevronLeft,
  Clock3,
  Database,
  Layers,
  Loader2,
  LoaderCircle,
  Search,
  XCircle,
} from "lucide-react"
import { useMemo, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { humanizeIdentifier } from "../lib/labels"
import { formatRelativeTime } from "../lib/time"
import { getCollectionViewStyle, setCollectionViewStyle } from "../lib/userPreferences"

type Projection =
  | ListProjectionsResponse["objectProjections"][number]
  | ListProjectionsResponse["linkProjections"][number]
  | ListProjectionsResponse["telemetryProjections"][number]
type ProjectionRun = ListProjectionRunsResponse["runs"][number]
type ProjectionKind = ProjectionRun["projectionKind"]
type RunStatus = ProjectionRun["status"]
type ListViewStyle = "cards" | "table"

const listViewOptions = [
  { value: "cards", label: "Cards" },
  { value: "table", label: "Table" },
] as const

const KIND_LABEL: Record<ProjectionKind, string> = {
  object: "Object",
  link: "Link",
  telemetry: "Telemetry",
}

function projectionKind(projection: Pick<Projection, "_tag">): ProjectionKind {
  if (projection._tag === "ObjectProjectionDefinition") return "object"
  if (projection._tag === "LinkProjectionDefinition") return "link"
  return "telemetry"
}

function projectionName(projection: Pick<Projection, "id">): string {
  return humanizeIdentifier(projection.id)
}

function runStatusLabel(status: RunStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1)
}

function runStatusClasses(status: RunStatus): string {
  switch (status) {
    case "succeeded":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"
    case "failed":
      return "border-destructive/30 bg-destructive/10 text-destructive"
    case "cancelled":
      return "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-300"
    case "running":
      return "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-300"
  }
}

function RunStatusBadge({ status }: { status: RunStatus }) {
  const Icon =
    status === "succeeded"
      ? CheckCircle2
      : status === "failed"
        ? XCircle
        : status === "cancelled"
          ? Ban
          : LoaderCircle

  return (
    <Badge variant="outline" className={cn("rounded-md", runStatusClasses(status))}>
      <Icon className={cn("h-3 w-3", status === "running" && "animate-spin")} />
      {runStatusLabel(status)}
    </Badge>
  )
}

function KindBadge({ kind }: { kind: ProjectionKind }) {
  return (
    <Badge variant="outline" className="rounded-md text-muted-foreground">
      {KIND_LABEL[kind]}
    </Badge>
  )
}

function runMetrics(run: ProjectionRun): { label: string; value: number }[] {
  return [
    { label: "Rows read", value: run.sourceRowsRead },
    { label: "Rows skipped", value: run.sourceRowsSkipped },
  ]
}

function primaryMetric(run: ProjectionRun): { label: string; value: number } {
  return { label: "Rows", value: run.sourceRowsRead }
}

// Run ids stay stable across retries; the attempt is a separate execution counter.
function runLabel(run: ProjectionRun): string {
  const id = run.id.length > 8 ? run.id.slice(0, 8) : run.id
  return run.attempt === undefined ? id : `${id} · attempt ${run.attempt}`
}

function runDuration(run: ProjectionRun): string {
  if (!run.finishedAt) {
    return run.status === "running" ? "Running" : "Pending"
  }

  const durationMs = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()
  if (!Number.isFinite(durationMs) || durationMs < 0) return "Unknown"
  if (durationMs < 1000) return "<1s"
  if (durationMs < 60_000) return `${Math.round(durationMs / 1000)}s`

  const minutes = Math.floor(durationMs / 60_000)
  const seconds = Math.round((durationMs % 60_000) / 1000)
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
}

function ProjectionListItem({
  projection,
  onSelect,
}: {
  projection: Projection
  onSelect: () => void
}) {
  const latestRun = projection.latestRun

  return (
    <CollectionCardButton onClick={onSelect}>
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Layers className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-sm font-medium text-foreground">
            {projectionName(projection)}
          </p>
          <KindBadge kind={projectionKind(projection)} />
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{projection.datasetId}</p>
      </div>
      {latestRun ? (
        <div className="hidden shrink-0 flex-col items-end gap-1 sm:flex">
          <RunStatusBadge status={latestRun.status} />
          <span className="text-xs text-muted-foreground">
            {formatRelativeTime(latestRun.startedAt)}
          </span>
        </div>
      ) : (
        <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">No runs</span>
      )}
    </CollectionCardButton>
  )
}

function ProjectionTableView({
  projections,
  onSelect,
}: {
  projections: Projection[]
  onSelect: (projectionId: string) => void
}) {
  return (
    <Card className="overflow-hidden p-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Projection</TableHead>
            <TableHead className="hidden sm:table-cell">Kind</TableHead>
            <TableHead className="hidden md:table-cell">Dataset</TableHead>
            <TableHead>Latest Run</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {projections.map((projection) => (
            <TableRow
              key={projection.id}
              onClick={() => onSelect(projection.id)}
              className="cursor-pointer"
            >
              <TableCell>
                <div className="flex min-w-0 items-center gap-2">
                  <Layers className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <p className="truncate text-sm font-medium text-foreground">
                    {projectionName(projection)}
                  </p>
                </div>
              </TableCell>
              <TableCell className="hidden sm:table-cell">
                <KindBadge kind={projectionKind(projection)} />
              </TableCell>
              <TableCell className="hidden font-mono text-xs text-muted-foreground md:table-cell">
                {projection.datasetId}
              </TableCell>
              <TableCell>
                {projection.latestRun ? (
                  <div className="flex flex-col items-start gap-1">
                    <RunStatusBadge status={projection.latestRun.status} />
                    <span className="text-xs text-muted-foreground">
                      {formatRelativeTime(projection.latestRun.startedAt)}
                    </span>
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground">No runs</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  )
}

export function ProjectionsPage() {
  const { data, isLoading, isError } = useQuery(listProjectionsOptions())
  const navigate = useNavigate()
  const [searchQuery, setSearchQuery] = useState("")
  const [viewStyle, setViewStyle] = useState<ListViewStyle>(() =>
    getCollectionViewStyle("projections", ["cards", "table"], "cards")
  )

  const projections = useMemo<Projection[]>(
    () => [
      ...(data?.objectProjections ?? []),
      ...(data?.linkProjections ?? []),
      ...(data?.telemetryProjections ?? []),
    ],
    [data]
  )

  const filteredProjections = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return projections

    return projections.filter((projection) =>
      [
        projection.id,
        projectionKind(projection),
        projection.datasetId,
        projection.latestRun?.status ?? "",
      ].some((value) => value.toLowerCase().includes(query))
    )
  }, [projections, searchQuery])

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center py-24">
        <div className="flex items-center gap-3 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Loading projections...</span>
        </div>
      </div>
    )
  }

  if (isError) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="w-full max-w-md rounded-lg border border-border bg-card p-6">
          <EmptyState
            icon={<Layers className="h-10 w-10" />}
            title="Projections unavailable"
            description="Could not load projection metadata."
          />
        </div>
      </div>
    )
  }

  const handleSelect = (projectionId: string) => {
    navigate(`/projections/${encodeURIComponent(projectionId)}`)
  }

  return (
    <div className="mx-auto w-full max-w-5xl">
      <CollectionHeader
        title="Projections"
        count={filteredProjections.length}
        actions={
          projections.length > 0 ? (
            <CollectionViewToggle
              value={viewStyle}
              options={listViewOptions}
              onChange={(style) => {
                setViewStyle(style)
                setCollectionViewStyle("projections", style)
              }}
            />
          ) : null
        }
      />

      {projections.length > 0 && (
        <div className="relative mt-2">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search projections, kinds, or datasets..."
            className="pl-9"
          />
        </div>
      )}

      <div className="mt-4">
        {projections.length === 0 ? (
          <EmptyState
            icon={<Layers className="h-10 w-10" />}
            title="No projections"
            description="Registered projections will appear here."
          />
        ) : filteredProjections.length === 0 ? (
          <EmptyState
            icon={<Search className="h-9 w-9" />}
            title="No results"
            description="Try another search."
            className="py-12"
          />
        ) : viewStyle === "table" ? (
          <ProjectionTableView projections={filteredProjections} onSelect={handleSelect} />
        ) : (
          <CollectionCardGrid>
            {filteredProjections.map((projection) => (
              <ProjectionListItem
                key={projection.id}
                projection={projection}
                onSelect={() => handleSelect(projection.id)}
              />
            ))}
          </CollectionCardGrid>
        )}
      </div>
    </div>
  )
}

function DetailSurface({
  title,
  trailing,
  children,
}: {
  title: string
  trailing?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="min-w-0 max-w-full overflow-hidden rounded-lg border border-border bg-card px-4 py-5 sm:px-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-normal text-foreground">{title}</h2>
        {trailing}
      </div>
      {children}
    </section>
  )
}

function MetricTile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 px-4 py-3">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="mt-1 min-w-0 text-sm text-foreground">{children}</div>
    </div>
  )
}

function LatestRunSummary({ run }: { run: ProjectionRun | null }) {
  const metric = run ? primaryMetric(run) : null
  const dash = <span className="text-muted-foreground">—</span>

  return (
    <div className="grid overflow-hidden rounded-lg border border-border bg-card sm:grid-cols-2 sm:divide-x sm:divide-border/60 lg:grid-cols-4">
      <MetricTile label="Latest run">
        {run ? (
          <RunStatusBadge status={run.status} />
        ) : (
          <span className="text-muted-foreground">No runs yet</span>
        )}
      </MetricTile>
      <MetricTile label="Started">{run ? formatRelativeTime(run.startedAt) : dash}</MetricTile>
      <MetricTile label="Duration">
        {run ? <span className="tabular-nums">{runDuration(run)}</span> : dash}
      </MetricTile>
      <MetricTile label={metric?.label ?? "Processed"}>
        {metric ? <span className="tabular-nums">{metric.value.toLocaleString()}</span> : dash}
      </MetricTile>
    </div>
  )
}

function ProjectionRunList({ runs }: { runs: ProjectionRun[] }) {
  if (runs.length === 0) {
    return (
      <EmptyState
        icon={<Clock3 className="h-10 w-10" />}
        title="No runs yet"
        description="Runs appear here after the projection's dataset is committed."
        className="py-10"
      />
    )
  }

  const metricLabels = runMetrics(runs[0]).map((metric) => metric.label)
  const headCell = "whitespace-nowrap pb-2 text-xs font-medium text-muted-foreground"
  const numCell = "px-3 py-3 text-right tabular-nums text-foreground"

  return (
    <>
      {/* Desktop: dense, scannable run-history table. */}
      <div className="-mx-1 hidden max-h-[460px] overflow-auto px-1 md:block">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="sticky top-0 z-10 border-b border-border bg-card">
              <th className={cn(headCell, "pr-3")}>Status</th>
              <th className={cn(headCell, "px-3")}>Run</th>
              <th className={cn(headCell, "px-3")}>Started</th>
              <th className={cn(headCell, "px-3 text-right")}>Duration</th>
              {metricLabels.map((label) => (
                <th key={label} className={cn(headCell, "px-3 text-right")}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {runs.map((run) => (
              <tr key={run.id} className="align-top transition-colors hover:bg-muted/40">
                <td className="py-3 pr-3">
                  <RunStatusBadge status={run.status} />
                </td>
                <td className="px-3 py-3">
                  <p className="font-mono text-xs text-foreground" title={run.id}>
                    {runLabel(run)}
                  </p>
                  <p
                    className="mt-0.5 max-w-[180px] truncate font-mono text-xs text-muted-foreground"
                    title={run.datasetVersionId}
                  >
                    {run.datasetVersionId}
                  </p>
                  {run.errorMessage && (
                    <p className="mt-1 break-words text-xs text-destructive">{run.errorMessage}</p>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-muted-foreground">
                  {formatRelativeTime(run.startedAt)}
                </td>
                <td className={cn(numCell, "text-muted-foreground")}>{runDuration(run)}</td>
                {runMetrics(run).map((metric) => (
                  <td
                    key={metric.label}
                    className={cn(
                      numCell,
                      metric.label === "Failed" && metric.value > 0 && "text-destructive"
                    )}
                  >
                    {metric.value.toLocaleString()}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile: stacked, divided rows. */}
      <div className="divide-y divide-border/60 md:hidden">
        {runs.map((run) => (
          <div key={run.id} className="py-3 first:pt-0">
            <div className="flex items-center justify-between gap-2">
              <RunStatusBadge status={run.status} />
              <span className="text-xs text-muted-foreground">
                {formatRelativeTime(run.startedAt)}
              </span>
            </div>
            <p className="mt-2 font-mono text-xs text-foreground" title={run.id}>
              {runLabel(run)}
            </p>
            <p
              className="truncate font-mono text-xs text-muted-foreground"
              title={run.datasetVersionId}
            >
              {run.datasetVersionId}
            </p>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
              <span>{runDuration(run)}</span>
              {runMetrics(run).map((metric) => (
                <span key={metric.label}>
                  {metric.value.toLocaleString()} {metric.label.toLowerCase()}
                </span>
              ))}
            </div>
            {run.errorMessage && (
              <p className="mt-2 break-words text-xs text-destructive">{run.errorMessage}</p>
            )}
          </div>
        ))}
      </div>
    </>
  )
}

function Mono({ value, muted }: { value: string; muted?: boolean }) {
  return <span className={cn("font-mono text-xs", muted && "text-muted-foreground")}>{value}</span>
}

function MappingTable({
  columns,
  rows,
}: {
  columns: string[]
  rows: { key: string; cells: React.ReactNode[] }[]
}) {
  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="border-b border-border">
          {columns.map((column, index) => (
            <th
              key={column}
              className={cn(
                "pb-2 text-xs font-medium text-muted-foreground",
                index === 0 ? "pr-3" : "px-3"
              )}
            >
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-border/60">
        {rows.map((row) => (
          <tr key={row.key}>
            {row.cells.map((cell, index) => (
              <td
                key={columns[index]}
                className={cn("py-2.5 align-top text-foreground", index === 0 ? "pr-3" : "px-3")}
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function FlowChip({
  icon: Icon,
  label,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  onClick?: () => void
}) {
  const className = cn(
    "inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1",
    onClick && "transition-colors hover:bg-muted/50"
  )
  const content = (
    <>
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate font-mono text-xs text-foreground">{label}</span>
    </>
  )
  return onClick ? (
    <button type="button" onClick={onClick} className={className}>
      {content}
    </button>
  ) : (
    <span className={className}>{content}</span>
  )
}

function FlowArrow() {
  return <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
}

// Source dataset → target object type (and, for telemetry/links, the precise
// target property or relationship) — the projection's purpose at a glance.
function ProjectionFlow({ projection }: { projection: GetProjectionResponse }) {
  const navigate = useNavigate()
  const toType = (id: string) => navigate(`/ontology/${encodeURIComponent(id)}`)
  const dataset = (
    <FlowChip
      icon={Database}
      label={projection.datasetId}
      onClick={() => navigate(`/datasets/${encodeURIComponent(projection.datasetId)}`)}
    />
  )

  if (projection._tag === "LinkProjectionDefinition") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {dataset}
        <FlowArrow />
        <FlowChip
          icon={Box}
          label={projection.sourceObjectTypeId}
          onClick={() => toType(projection.sourceObjectTypeId)}
        />
        <Mono value={projection.linkId} muted />
        <FlowArrow />
        <FlowChip
          icon={Box}
          label={projection.targetObjectTypeId}
          onClick={() => toType(projection.targetObjectTypeId)}
        />
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {dataset}
      <FlowArrow />
      <FlowChip
        icon={Box}
        label={projection.objectTypeId}
        onClick={() => toType(projection.objectTypeId)}
      />
      {projection._tag === "TelemetryProjectionDefinition" && (
        <Mono value={`· ${projection.propertyId}`} muted />
      )}
    </div>
  )
}

// Shows how dataset columns map onto the projected target, per projection kind.
function ProjectionMapping({ projection }: { projection: GetProjectionResponse }) {
  if (projection._tag === "ObjectProjectionDefinition") {
    const properties = Object.entries(projection.properties)
    const links = Object.entries(projection.links)
    const propertiesTable = (
      <MappingTable
        columns={["Object property", "Dataset column"]}
        rows={properties.map(([property, column]) => ({
          key: property,
          cells: [<Mono key="p" value={property} />, <Mono key="c" value={column} muted />],
        }))}
      />
    )

    // No links → the properties table is the whole mapping; keep it readable
    // rather than stretched across the card.
    if (links.length === 0) {
      return <div className="max-w-xl">{propertiesTable}</div>
    }

    // Two self-describing tables side by side — the column headers ("Object
    // property" vs "Link") identify each, so no extra section headings.
    return (
      <div className="grid gap-x-8 gap-y-6 md:grid-cols-2">
        <div className="min-w-0">{propertiesTable}</div>
        <div className="min-w-0">
          <MappingTable
            columns={["Link", "Target type", "From column"]}
            rows={links.map(([linkId, descriptor]) => ({
              key: linkId,
              cells: [
                <Mono key="l" value={linkId} />,
                <Mono key="t" value={descriptor.targetObjectTypeId} />,
                <Mono
                  key="f"
                  value={descriptor.sourceField ?? descriptor.sourcePropertyId ?? "—"}
                  muted
                />,
              ],
            }))}
          />
        </div>
      </div>
    )
  }

  if (projection._tag === "LinkProjectionDefinition") {
    return (
      <div className="max-w-xl">
        <MappingTable
          columns={["Endpoint", "Object type", "Match column"]}
          rows={[
            {
              key: "source",
              cells: [
                "Source",
                <Mono key="t" value={projection.sourceObjectTypeId} />,
                <Mono key="c" value={projection.sourceField} muted />,
              ],
            },
            {
              key: "target",
              cells: [
                "Target",
                <Mono key="t" value={projection.targetObjectTypeId} />,
                <Mono key="c" value={projection.targetField} muted />,
              ],
            },
          ]}
        />
      </div>
    )
  }

  return (
    <div className="max-w-md">
      <MappingTable
        columns={["Point field", "Dataset column"]}
        rows={[
          {
            key: "objectId",
            cells: ["Object id", <Mono key="c" value={projection.objectIdField} muted />],
          },
          { key: "at", cells: ["Timestamp", <Mono key="c" value={projection.atField} muted />] },
          { key: "value", cells: ["Value", <Mono key="c" value={projection.valueField} muted />] },
          {
            key: "unit",
            cells: [
              "Unit",
              projection.unitField ? (
                <Mono key="c" value={projection.unitField} muted />
              ) : (
                <span key="c" className="text-muted-foreground">
                  —
                </span>
              ),
            ],
          },
        ]}
      />
    </div>
  )
}

export function ProjectionDetailPage() {
  const { projectionId = "" } = useParams()
  const navigate = useNavigate()
  const decodedId = decodeURIComponent(projectionId)

  const projectionQuery = useQuery({
    ...getProjectionOptions({ path: { projectionId: decodedId } }),
    enabled: decodedId.length > 0,
  })

  const runsQuery = useQuery({
    ...listProjectionRunsOptions({
      query: { projectionId: decodedId, limit: "20", order: "desc" },
    }),
    enabled: decodedId.length > 0,
    refetchInterval: 5000,
  })

  const projection = projectionQuery.data
  const runs = runsQuery.data?.runs ?? []
  const latestRun = runs[0] ?? projection?.latestRun ?? null

  if (projectionQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center py-24">
        <div className="flex items-center gap-3 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Loading projection...</span>
        </div>
      </div>
    )
  }

  if (projectionQuery.isError || !projection) {
    return (
      <div className="mx-auto w-full max-w-2xl space-y-4">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => navigate("/projections")}
          className="-ml-2 text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft />
          Projections
        </Button>
        <div className="rounded-lg border border-border bg-card p-8">
          <EmptyState
            icon={<Layers className="h-10 w-10" />}
            title="Projection not found"
            description="This projection is not registered in the active Sixb runtime."
          />
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-5xl space-y-4 overflow-hidden">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => navigate("/projections")}
        className="-ml-2 self-start text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft />
        Projections
      </Button>

      <header className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm text-muted-foreground">
            {KIND_LABEL[projectionKind(projection)]} projection
          </p>
          <KindBadge kind={projectionKind(projection)} />
        </div>
        <h1 className="mt-1 text-2xl font-semibold tracking-normal text-foreground sm:text-3xl">
          {projectionName(projection)}
        </h1>
        <p className="mt-2 break-all font-mono text-xs text-muted-foreground">{projection.id}</p>
        <div className="mt-3">
          <ProjectionFlow projection={projection} />
        </div>
      </header>

      <LatestRunSummary run={latestRun} />

      <DetailSurface title="Field mapping">
        <ProjectionMapping projection={projection} />
      </DetailSurface>

      <DetailSurface
        title="Recent Runs"
        trailing={
          runs.length > 0 ? (
            <span className="tabular-nums text-xs text-muted-foreground">
              {runs.length} {runs.length === 1 ? "run" : "runs"}
            </span>
          ) : undefined
        }
      >
        {runsQuery.isLoading ? (
          <div className="py-10">
            <div className="flex items-center gap-3 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-sm">Loading runs...</span>
            </div>
          </div>
        ) : runsQuery.isError ? (
          <EmptyState
            icon={<Clock3 className="h-10 w-10" />}
            title="Runs unavailable"
            description="Could not load projection run history."
            className="py-8"
          />
        ) : (
          <ProjectionRunList runs={runs} />
        )}
      </DetailSurface>
    </div>
  )
}
