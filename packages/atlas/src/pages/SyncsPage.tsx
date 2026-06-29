import type { GetSyncResponse, ListSyncRunsResponse, ListSyncsResponse } from "@sixb/client"
import {
  getSyncOptions,
  listSyncRunsOptions,
  listSyncsOptions,
  requestSyncRunMutation,
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
import { useMutation, useQuery } from "@tanstack/react-query"
import {
  Ban,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Database,
  Loader2,
  LoaderCircle,
  Play,
  RefreshCw,
  Search,
  XCircle,
} from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { useSyncLiveUpdates } from "../features/syncs/hooks/useSyncLiveUpdates"
import { humanizeIdentifier } from "../lib/labels"
import { formatRelativeTime } from "../lib/time"
import { getCollectionViewStyle, setCollectionViewStyle } from "../lib/userPreferences"

type SyncSummary = ListSyncsResponse[number] | GetSyncResponse
type SyncRun = ListSyncRunsResponse["runs"][number]
type SyncListViewStyle = "cards" | "table"
type QueuedRun = {
  readonly id: string
  readonly queuedAt: string
}
type DisplayRun = SyncRun | QueuedRun

const syncListViewOptions = [
  { value: "cards", label: "Cards" },
  { value: "table", label: "Table" },
] as const

function isQueuedRun(run: DisplayRun): run is QueuedRun {
  return !("status" in run)
}

function syncName(sync: Pick<SyncSummary, "id">): string {
  return humanizeIdentifier(sync.id)
}

function runStatusLabel(status: SyncRun["status"]): string {
  return status.charAt(0).toUpperCase() + status.slice(1)
}

function runStatusClasses(status: SyncRun["status"]): string {
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

function RunStatusBadge({ status }: { status: SyncRun["status"] }) {
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

function QueuedRunBadge() {
  return (
    <Badge
      variant="outline"
      className="rounded-md border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-300"
    >
      <Clock3 className="h-3 w-3" />
      Queued
    </Badge>
  )
}

function syncSummary(sync: SyncSummary): string {
  const parts = [`${sync.mode} sync`, sync.connector.id, sync.target.dataset.id]
  if (sync.triggers.length > 0) {
    parts.push(`${sync.triggers.length} trigger${sync.triggers.length === 1 ? "" : "s"}`)
  }
  return parts.join(" / ")
}

function triggerLabel(trigger: SyncSummary["triggers"][number]): string {
  switch (trigger.type) {
    case "schedule":
      return `Schedule ${trigger.scheduleId}`
    case "sync.finished":
      return `After ${trigger.syncId}`
    case "pipeline.finished":
      return `After ${trigger.pipelineId}`
    case "dataset.updated":
      return `Dataset ${trigger.datasetId}`
  }
}

function runDuration(run: SyncRun): string {
  if (!run.finishedAt) {
    return run.status === "running" ? "Running" : "Pending"
  }

  const durationMs = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return "Unknown"
  }
  if (durationMs < 1000) {
    return "<1s"
  }
  if (durationMs < 60_000) {
    return `${Math.round(durationMs / 1000)}s`
  }

  const minutes = Math.floor(durationMs / 60_000)
  const seconds = Math.round((durationMs % 60_000) / 1000)
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "error" in error) {
    const value = (error as { error?: unknown }).error
    if (typeof value === "string") return value
  }
  return "Could not request sync run."
}

function SyncListItem({
  sync,
  onSelect,
}: {
  sync: ListSyncsResponse[number]
  onSelect: () => void
}) {
  const latestRun = sync.latestRun

  return (
    <CollectionCardButton onClick={onSelect}>
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <RefreshCw className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-sm font-medium text-foreground">{syncName(sync)}</p>
          <span className="shrink-0 rounded-md bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {sync.mode}
          </span>
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{sync.target.dataset.id}</p>
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

function SyncTableView({
  syncs,
  onSelect,
}: {
  syncs: ListSyncsResponse
  onSelect: (syncId: string) => void
}) {
  return (
    <Card className="overflow-hidden p-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Sync</TableHead>
            <TableHead className="hidden sm:table-cell">Dataset</TableHead>
            <TableHead className="hidden md:table-cell">Connector</TableHead>
            <TableHead>Latest Run</TableHead>
            <TableHead className="hidden text-right lg:table-cell">Triggers</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {syncs.map((sync) => (
            <TableRow key={sync.id} onClick={() => onSelect(sync.id)} className="cursor-pointer">
              <TableCell>
                <div className="flex min-w-0 items-center gap-2">
                  <RefreshCw className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{syncName(sync)}</p>
                    <p className="font-mono text-[11px] text-muted-foreground">{sync.mode}</p>
                  </div>
                </div>
              </TableCell>
              <TableCell className="hidden font-mono text-xs text-muted-foreground sm:table-cell">
                {sync.target.dataset.id}
              </TableCell>
              <TableCell className="hidden font-mono text-xs text-muted-foreground md:table-cell">
                {sync.connector.id}
              </TableCell>
              <TableCell>
                {sync.latestRun ? (
                  <div className="flex flex-col items-start gap-1">
                    <RunStatusBadge status={sync.latestRun.status} />
                    <span className="text-xs text-muted-foreground">
                      {formatRelativeTime(sync.latestRun.startedAt)}
                    </span>
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground">No runs</span>
                )}
              </TableCell>
              <TableCell className="hidden text-right text-sm text-muted-foreground lg:table-cell">
                {sync.triggers.length}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
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

function DetailSurface({
  title,
  children,
  className,
}: {
  title: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <section
      className={cn(
        "min-w-0 max-w-full overflow-hidden rounded-lg border border-border bg-card px-4 py-5 sm:px-5",
        className
      )}
    >
      <div className="mb-4 flex items-center justify-between gap-4">
        <h2 className="text-sm font-semibold tracking-normal text-foreground">{title}</h2>
      </div>
      {children}
    </section>
  )
}

function MetricTile({
  label,
  value,
  detail,
  children,
}: {
  label: string
  value?: React.ReactNode
  detail?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div className="min-w-0 px-4 py-3">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="mt-1 min-w-0 text-sm text-foreground">
        {children ?? value ?? <span className="text-muted-foreground">-</span>}
      </div>
      {detail && <div className="mt-2 truncate text-xs text-muted-foreground">{detail}</div>}
    </div>
  )
}

function LatestRunSummary({ run }: { run: DisplayRun | null }) {
  if (!run) {
    return (
      <div className="grid rounded-lg border border-border bg-card sm:grid-cols-2 lg:grid-cols-4 lg:divide-x lg:divide-border/40">
        <MetricTile label="Latest run" value="No runs yet" />
        <MetricTile label="Started" />
        <MetricTile label="Duration" />
        <MetricTile label="Rows" />
      </div>
    )
  }

  return (
    <div className="grid overflow-hidden rounded-lg border border-border bg-card sm:grid-cols-2 sm:divide-x sm:divide-y-0 sm:divide-border/40 lg:grid-cols-4">
      <MetricTile
        label="Latest run"
        detail={
          !isQueuedRun(run) && run.output ? (
            <span className="font-mono">{run.output.versionId}</span>
          ) : undefined
        }
      >
        <div className="flex min-w-0 items-center gap-2 overflow-hidden">
          <span className="shrink-0">
            {isQueuedRun(run) ? <QueuedRunBadge /> : <RunStatusBadge status={run.status} />}
          </span>
          <span className="hidden truncate font-mono text-xs text-muted-foreground sm:block">
            {run.id}
          </span>
        </div>
      </MetricTile>
      <MetricTile
        label={isQueuedRun(run) ? "Queued" : "Started"}
        value={formatRelativeTime(isQueuedRun(run) ? run.queuedAt : run.startedAt)}
      />
      <MetricTile label="Duration" value={isQueuedRun(run) ? "Waiting" : runDuration(run)} />
      <MetricTile label="Rows" value={isQueuedRun(run) ? "-" : (run.rowsRead ?? 0)} />
    </div>
  )
}

function SchemaTable({ sync }: { sync: SyncSummary }) {
  const columns = sync.target.dataset.schema.columns

  if (columns.length === 0) {
    return (
      <EmptyState
        icon={<Database className="h-10 w-10" />}
        title="No schema"
        description="This sync target has no declared columns."
        className="py-8"
      />
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-border text-xs text-muted-foreground">
            <th className="pb-2 font-medium">Column</th>
            <th className="pb-2 font-medium">Type</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/40">
          {columns.map((column) => (
            <tr key={column.name}>
              <td className="py-2.5 pr-4 font-mono text-xs text-foreground">{column.name}</td>
              <td className="py-2.5 font-mono text-xs text-muted-foreground">
                {column.type}
                {column.nullable ? "?" : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SyncRunCard({ run }: { run: DisplayRun }) {
  if (isQueuedRun(run)) {
    return (
      <div className="min-w-0 max-w-full overflow-hidden rounded-xl border border-border bg-background p-3">
        <div className="min-w-0 space-y-2">
          <QueuedRunBadge />
          <div className="min-w-0">
            <p className="max-w-full truncate font-mono text-xs text-foreground">{run.id}</p>
            <p className="mt-1 max-w-full truncate text-xs text-muted-foreground">
              Queued {formatRelativeTime(run.queuedAt)}
            </p>
          </div>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">Waiting for a worker</p>
      </div>
    )
  }

  return (
    <div className="min-w-0 max-w-full overflow-hidden rounded-xl border border-border bg-background p-3">
      <div className="min-w-0 space-y-2">
        <RunStatusBadge status={run.status} />
        <div className="min-w-0">
          <p className="max-w-full truncate font-mono text-xs text-foreground">{run.id}</p>
          {run.output && (
            <p className="mt-1 max-w-full truncate font-mono text-xs text-muted-foreground">
              {run.output.versionId}
            </p>
          )}
        </div>
      </div>
      <div className="mt-3 grid min-w-0 grid-cols-3 gap-2 text-xs">
        <div className="min-w-0">
          <p className="text-muted-foreground">Started</p>
          <p className="mt-0.5 truncate text-foreground">{formatRelativeTime(run.startedAt)}</p>
        </div>
        <div className="min-w-0">
          <p className="text-muted-foreground">Duration</p>
          <p className="mt-0.5 truncate text-foreground">{runDuration(run)}</p>
        </div>
        <div className="min-w-0">
          <p className="text-muted-foreground">Rows</p>
          <p className="mt-0.5 truncate text-foreground">{run.rowsRead ?? 0}</p>
        </div>
      </div>
      {run.error && (
        <p className="mt-3 break-words text-xs text-destructive">
          {run.error.name ? `${run.error.name}: ` : ""}
          {run.error.message}
        </p>
      )}
    </div>
  )
}

function SyncRunList({ runs, queuedRun }: { runs: SyncRun[]; queuedRun: QueuedRun | null }) {
  if (runs.length === 0 && !queuedRun) {
    return (
      <EmptyState
        icon={<Clock3 className="h-10 w-10" />}
        title="No runs"
        description="Requested and scheduled runs will appear here."
        className="py-8"
      />
    )
  }

  return (
    <>
      <div className="min-w-0 max-w-full space-y-2 overflow-hidden md:hidden">
        {queuedRun && <SyncRunCard run={queuedRun} />}
        {runs.map((run) => (
          <SyncRunCard key={run.id} run={run} />
        ))}
      </div>
      <div className="hidden max-h-[420px] overflow-auto md:block">
        <table className="w-full min-w-[620px] table-fixed text-left text-sm">
          <colgroup>
            <col className="w-[42%]" />
            <col className="w-[18%]" />
            <col className="w-[16%]" />
            <col className="w-[14%]" />
            <col className="w-[10%]" />
          </colgroup>
          <thead>
            <tr className="sticky top-0 border-b border-border bg-card text-xs text-muted-foreground">
              <th className="pb-2 pr-4 font-medium">Run</th>
              <th className="px-3 pb-2 font-medium">Status</th>
              <th className="px-3 pb-2 font-medium">Started</th>
              <th className="px-3 pb-2 font-medium">Duration</th>
              <th className="pb-2 pl-3 text-right font-medium">Rows</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/40">
            {queuedRun && (
              <tr className="align-top">
                <td className="py-3 pr-4">
                  <p className="truncate font-mono text-xs text-foreground">{queuedRun.id}</p>
                  <p className="mt-1 text-xs text-muted-foreground">Waiting for a worker</p>
                </td>
                <td className="px-3 py-3">
                  <QueuedRunBadge />
                </td>
                <td className="px-3 py-3 text-muted-foreground">
                  {formatRelativeTime(queuedRun.queuedAt)}
                </td>
                <td className="px-3 py-3 text-muted-foreground">Waiting</td>
                <td className="py-3 pl-3 text-right text-muted-foreground">-</td>
              </tr>
            )}
            {runs.map((run) => (
              <tr key={run.id} className="align-top">
                <td className="py-3 pr-4">
                  <p className="truncate font-mono text-xs text-foreground">{run.id}</p>
                  {run.output && (
                    <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                      {run.output.versionId}
                    </p>
                  )}
                  {run.error && (
                    <p className="mt-1 text-xs text-destructive">
                      {run.error.name ? `${run.error.name}: ` : ""}
                      {run.error.message}
                    </p>
                  )}
                </td>
                <td className="px-3 py-3">
                  <RunStatusBadge status={run.status} />
                </td>
                <td className="px-3 py-3 text-muted-foreground">
                  {formatRelativeTime(run.startedAt)}
                </td>
                <td className="px-3 py-3 text-muted-foreground">{runDuration(run)}</td>
                <td className="py-3 pl-3 text-right text-foreground">{run.rowsRead ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

export function SyncsPage() {
  const { data: syncs = [], isLoading, isError } = useQuery(listSyncsOptions())
  useSyncLiveUpdates({ enabled: syncs.length > 0 })
  const navigate = useNavigate()
  const [searchQuery, setSearchQuery] = useState("")
  const [viewStyle, setViewStyle] = useState<SyncListViewStyle>(() =>
    getCollectionViewStyle("syncs", ["cards", "table"], "cards")
  )

  const filteredSyncs = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return syncs

    return syncs.filter((sync) => {
      return (
        sync.id.toLowerCase().includes(query) ||
        sync.mode.toLowerCase().includes(query) ||
        sync.connector.id.toLowerCase().includes(query) ||
        sync.connector.type.toLowerCase().includes(query) ||
        sync.target.dataset.id.toLowerCase().includes(query) ||
        sync.latestRun?.status.toLowerCase().includes(query)
      )
    })
  }, [syncs, searchQuery])

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center py-24">
        <div className="flex items-center gap-3 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Loading syncs...</span>
        </div>
      </div>
    )
  }

  if (isError) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="w-full max-w-md rounded-lg border border-border bg-card p-6">
          <EmptyState
            icon={<RefreshCw className="h-10 w-10" />}
            title="Syncs unavailable"
            description="Could not load sync metadata."
          />
        </div>
      </div>
    )
  }

  const handleSelectSync = (syncId: string) => {
    navigate(`/syncs/${encodeURIComponent(syncId)}`)
  }

  return (
    <div className="mx-auto w-full max-w-5xl">
      <CollectionHeader
        title="Syncs"
        count={filteredSyncs.length}
        actions={
          syncs.length > 0 ? (
            <CollectionViewToggle
              value={viewStyle}
              options={syncListViewOptions}
              onChange={(style) => {
                setViewStyle(style)
                setCollectionViewStyle("syncs", style)
              }}
            />
          ) : null
        }
      />

      {syncs.length > 0 && (
        <div className="relative mt-2">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search syncs, connectors, or datasets..."
            className="pl-9"
          />
        </div>
      )}

      <div className="mt-4">
        {syncs.length === 0 ? (
          <EmptyState
            icon={<RefreshCw className="h-10 w-10" />}
            title="No syncs"
            description="Registered syncs will appear here."
          />
        ) : filteredSyncs.length === 0 ? (
          <EmptyState
            icon={<Search className="h-9 w-9" />}
            title="No results"
            description="Try another search."
            className="py-12"
          />
        ) : viewStyle === "table" ? (
          <SyncTableView syncs={filteredSyncs} onSelect={handleSelectSync} />
        ) : (
          <CollectionCardGrid>
            {filteredSyncs.map((sync) => (
              <SyncListItem key={sync.id} sync={sync} onSelect={() => handleSelectSync(sync.id)} />
            ))}
          </CollectionCardGrid>
        )}
      </div>
    </div>
  )
}

export function SyncDetailPage() {
  const { syncId = "" } = useParams()
  const navigate = useNavigate()
  const decodedSyncId = decodeURIComponent(syncId)
  const [queuedRun, setQueuedRun] = useState<QueuedRun | null>(null)
  useSyncLiveUpdates({ syncId: decodedSyncId, enabled: decodedSyncId.length > 0 })

  const syncQuery = useQuery({
    ...getSyncOptions({
      path: { syncId: decodedSyncId },
    }),
    enabled: decodedSyncId.length > 0,
  })

  const runsQuery = useQuery({
    ...listSyncRunsOptions({
      query: { syncId: decodedSyncId, limit: "12", order: "desc" },
    }),
    enabled: decodedSyncId.length > 0,
  })

  const requestRun = useMutation(requestSyncRunMutation())
  const sync = syncQuery.data
  const runs = runsQuery.data?.runs ?? []
  const optimisticQueuedRun = queuedRun
    ? runs.some((run) => run.id === queuedRun.id)
      ? null
      : queuedRun
    : null
  const latestRun = optimisticQueuedRun ?? runs[0] ?? sync?.latestRun ?? null

  useEffect(() => {
    if (!queuedRun) return
    if (runs.some((run) => run.id === queuedRun.id)) {
      setQueuedRun(null)
    }
  }, [queuedRun, runs])

  const handleRequestRun = () => {
    requestRun.mutate(
      {
        path: { syncId: decodedSyncId },
        body: {
          commitMessage: `Manual run for ${decodedSyncId}`,
        },
      },
      {
        onSuccess: (result) => {
          setQueuedRun({ id: result.runId, queuedAt: result.queuedAt })
        },
      }
    )
  }

  if (syncQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center py-24">
        <div className="flex items-center gap-3 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Loading sync...</span>
        </div>
      </div>
    )
  }

  if (syncQuery.isError || !sync) {
    return (
      <div className="mx-auto w-full max-w-2xl space-y-4">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => navigate("/syncs")}
          className="-ml-2 text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft />
          Syncs
        </Button>
        <div className="rounded-lg border border-border bg-card p-8">
          <EmptyState
            icon={<RefreshCw className="h-10 w-10" />}
            title="Sync not found"
            description="This sync is not registered in the active Sixb runtime."
          />
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-5xl min-w-0 space-y-4 overflow-hidden">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => navigate("/syncs")}
        className="-ml-2 self-start text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft />
        Syncs
      </Button>

      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">{syncSummary(sync)}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-normal text-foreground sm:text-3xl">
            {syncName(sync)}
          </h1>
          <p className="mt-2 break-all font-mono text-xs text-muted-foreground">{sync.id}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => navigate(`/datasets/${encodeURIComponent(sync.target.dataset.id)}`)}
            className="mt-3 max-w-full justify-start text-muted-foreground hover:text-foreground"
          >
            <Database className="text-muted-foreground" />
            <span className="shrink-0">Outputs to</span>
            <span className="truncate font-mono text-foreground">{sync.target.dataset.id}</span>
            <ChevronRight className="text-muted-foreground" />
          </Button>
        </div>
        <Button
          type="button"
          size="lg"
          onClick={handleRequestRun}
          disabled={requestRun.isPending}
          className="w-full sm:w-auto"
        >
          {requestRun.isPending ? <LoaderCircle className="animate-spin" /> : <Play />}
          Run
        </Button>
      </header>

      <LatestRunSummary run={latestRun} />

      {requestRun.error && (
        <div className="rounded-lg border border-destructive/25 bg-destructive/10 px-5 py-3 text-sm text-destructive">
          {errorMessage(requestRun.error)}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="space-y-4">
          <DetailSurface title="Recent Runs">
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
                description="Could not load sync run history."
                className="py-8"
              />
            ) : (
              <SyncRunList runs={runs} queuedRun={optimisticQueuedRun} />
            )}
          </DetailSurface>

          <DetailSurface title="Schema">
            <SchemaTable sync={sync} />
          </DetailSurface>
        </div>

        <aside className="space-y-4">
          <DetailSurface title="Details">
            <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-1">
              <DetailField label="Mode" value={sync.mode} mono />
              <DetailField
                label="Connector"
                value={`${sync.connector.id} (${sync.connector.type})`}
                mono
              />
              <DetailField
                label="Dataset"
                mono
                value={
                  <Button
                    type="button"
                    variant="link"
                    className="h-auto justify-start gap-1 p-0 font-mono"
                    onClick={() =>
                      navigate(`/datasets/${encodeURIComponent(sync.target.dataset.id)}`)
                    }
                  >
                    <span className="truncate">{sync.target.dataset.id}</span>
                    <ChevronRight />
                  </Button>
                }
              />
              <DetailField label="Columns" value={sync.target.dataset.schema.columns.length} />
            </dl>
          </DetailSurface>

          <DetailSurface title="Triggers">
            {sync.triggers.length === 0 ? (
              <p className="text-sm text-muted-foreground">None</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {sync.triggers.map((trigger) => (
                  <span
                    key={triggerLabel(trigger)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm text-foreground"
                  >
                    <Clock3 className="h-3.5 w-3.5 text-muted-foreground" />
                    {triggerLabel(trigger)}
                  </span>
                ))}
              </div>
            )}
          </DetailSurface>
        </aside>
      </div>
    </div>
  )
}
