import type {
  GetConnectorResponse,
  ListConnectorsResponse,
  ListWebhookRunsResponse,
} from "@sixb/client"
import {
  getConnectorOptions,
  listConnectorsOptions,
  listWebhookRunsOptions,
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
  Cable,
  CheckCircle2,
  ChevronLeft,
  Clock3,
  GitBranch,
  Loader2,
  LoaderCircle,
  Search,
  Webhook,
  XCircle,
} from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { RunFailure } from "../components/common"
import {
  isUnconfiguredStorageError,
  UnrecordedHistoryState,
} from "../components/UnrecordedHistoryState"
import { formatBytes } from "../lib/datasets"
import { humanizeIdentifier } from "../lib/labels"
import { formatRelativeTime } from "../lib/time"
import { getCollectionViewStyle, setCollectionViewStyle } from "../lib/userPreferences"

type Connector = ListConnectorsResponse[number] | GetConnectorResponse
type WebhookRun = ListWebhookRunsResponse["runs"][number]
type ConnectorListViewStyle = "cards" | "table"

const connectorListViewOptions = [
  { value: "cards", label: "Cards" },
  { value: "table", label: "Table" },
] as const

function connectorName(connector: Connector): string {
  return humanizeIdentifier(connector.id)
}

function connectorSummary(connector: Connector): string {
  const parts = [`${connector.type} connector`]
  if (connector.syncIds.length > 0) {
    parts.push(`${connector.syncIds.length} sync${connector.syncIds.length === 1 ? "" : "s"}`)
  }
  if (connector.webhooks.length > 0) {
    parts.push(`${connector.webhooks.length} webhook${connector.webhooks.length === 1 ? "" : "s"}`)
  }
  return parts.join(" · ")
}

function webhookRunStatusLabel(status: WebhookRun["status"]): string {
  return status.charAt(0).toUpperCase() + status.slice(1)
}

function webhookRunStatusClasses(status: WebhookRun["status"]): string {
  switch (status) {
    case "succeeded":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"
    case "failed":
      return "border-destructive/30 bg-destructive/10 text-destructive"
    case "skipped":
      return "border-border bg-muted text-muted-foreground"
    case "running":
      return "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-300"
  }
}

function WebhookRunStatusBadge({ status }: { status: WebhookRun["status"] }) {
  let Icon = Clock3
  if (status === "succeeded") Icon = CheckCircle2
  if (status === "failed") Icon = XCircle
  if (status === "running") Icon = LoaderCircle

  return (
    <Badge variant="outline" className={cn("rounded-md", webhookRunStatusClasses(status))}>
      <Icon className={cn("h-3 w-3", status === "running" && "animate-spin")} />
      {webhookRunStatusLabel(status)}
    </Badge>
  )
}

function webhookRunDuration(run: WebhookRun): string {
  if (!run.finishedAt) {
    return run.status === "running" ? "Running" : "Pending"
  }

  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()
  if (!Number.isFinite(ms) || ms < 0) return "Unknown"
  if (ms < 1000) return "<1s"
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`

  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
}

function formatClaimResult(value: WebhookRun["deliveryClaimResult"]): string {
  if (!value) return "Claimed"
  return value.replace("_", " ").replace(/^./, (first) => first.toUpperCase())
}

function ConnectorListItem({
  connector,
  onSelect,
}: {
  connector: ListConnectorsResponse[number]
  onSelect: () => void
}) {
  return (
    <CollectionCardButton onClick={onSelect}>
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Cable className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-sm font-medium text-foreground">{connectorName(connector)}</p>
          <span className="shrink-0 rounded-md bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {connector.type}
          </span>
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{connector.id}</p>
      </div>
    </CollectionCardButton>
  )
}

function ConnectorTableView({
  connectors,
  onSelect,
}: {
  connectors: ListConnectorsResponse
  onSelect: (connectorId: string) => void
}) {
  return (
    <Card className="overflow-hidden p-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Connector</TableHead>
            <TableHead>Type</TableHead>
            <TableHead className="hidden text-right sm:table-cell">Syncs</TableHead>
            <TableHead className="hidden text-right md:table-cell">Webhooks</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {connectors.map((connector) => (
            <TableRow
              key={connector.id}
              onClick={() => onSelect(connector.id)}
              className="cursor-pointer"
            >
              <TableCell>
                <div className="flex min-w-0 items-center gap-2">
                  <Cable className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {connectorName(connector)}
                    </p>
                    <p className="font-mono text-[11px] text-muted-foreground">{connector.id}</p>
                  </div>
                </div>
              </TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">
                {connector.type}
              </TableCell>
              <TableCell className="hidden text-right text-sm text-muted-foreground sm:table-cell">
                {connector.syncIds.length}
              </TableCell>
              <TableCell className="hidden text-right text-sm text-muted-foreground md:table-cell">
                {connector.webhooks.length}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  )
}

function DetailRow({
  label,
  value,
  mono,
}: {
  label: string
  value: React.ReactNode
  mono?: boolean
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border py-2.5 last:border-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "max-w-[65%] break-words text-right text-sm text-foreground",
          mono && "font-mono text-xs"
        )}
      >
        {value}
      </dd>
    </div>
  )
}

function ConnectorSection({
  icon,
  title,
  empty,
  children,
}: {
  icon: React.ReactNode
  title: string
  empty: boolean
  children: React.ReactNode
}) {
  return (
    <section className="border-t border-border px-5 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">{icon}</span>
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
        </div>
        {empty ? (
          <p className="text-sm text-muted-foreground">None</p>
        ) : (
          <div className="min-w-0 flex-1 text-right">{children}</div>
        )}
      </div>
    </section>
  )
}

function WebhookFilterBar({
  connector,
  selectedWebhookId,
  onSelectWebhook,
}: {
  connector: Connector
  selectedWebhookId: string | null
  onSelectWebhook: (webhookId: string | null) => void
}) {
  if (connector.webhooks.length < 2) {
    return null
  }

  return (
    <div className="flex flex-wrap gap-2">
      <Button
        type="button"
        variant={selectedWebhookId === null ? "secondary" : "ghost"}
        size="sm"
        onClick={() => onSelectWebhook(null)}
      >
        All webhooks
      </Button>
      {connector.webhooks.map((webhook) => (
        <Button
          key={webhook.id}
          type="button"
          variant={selectedWebhookId === webhook.id ? "secondary" : "ghost"}
          size="sm"
          onClick={() => onSelectWebhook(webhook.id)}
          className="max-w-full"
        >
          <span className="truncate">{humanizeIdentifier(webhook.id)}</span>
        </Button>
      ))}
    </div>
  )
}

function WebhookRunIdempotency({ run }: { run: WebhookRun }) {
  if (!run.idempotencyKey) {
    return <span className="text-muted-foreground">-</span>
  }

  return (
    <div className="min-w-0">
      <p className="truncate font-mono text-xs text-foreground">{run.idempotencyKey}</p>
      <p className="mt-1 text-xs capitalize text-muted-foreground">
        {formatClaimResult(run.deliveryClaimResult)}
      </p>
    </div>
  )
}

function WebhookRunCard({ run }: { run: WebhookRun }) {
  return (
    <div className="rounded-lg border border-border bg-background/60 p-4">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">
            {humanizeIdentifier(run.webhookId)}
          </p>
          <p className="mt-1 font-mono text-xs text-muted-foreground">{run.id}</p>
        </div>
        <WebhookRunStatusBadge status={run.status} />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
        <div>
          <p className="text-muted-foreground">HTTP</p>
          <p className="mt-1 font-mono text-foreground">{run.responseStatus ?? "-"}</p>
        </div>
        <div>
          <p className="text-muted-foreground">Started</p>
          <p className="mt-1 text-foreground">{formatRelativeTime(run.startedAt)}</p>
        </div>
        <div>
          <p className="text-muted-foreground">Duration</p>
          <p className="mt-1 text-foreground">{webhookRunDuration(run)}</p>
        </div>
        <div>
          <p className="text-muted-foreground">Body</p>
          <p className="mt-1 font-mono text-foreground">{formatBytes(run.requestBodyBytes)}</p>
        </div>
      </div>
      {run.idempotencyKey && (
        <p className="mt-3 truncate font-mono text-xs text-muted-foreground">
          {formatClaimResult(run.deliveryClaimResult)} · {run.idempotencyKey}
        </p>
      )}
      {run.error && <RunFailure failure={run.error} variant="inline" className="mt-3 text-xs" />}
    </div>
  )
}

function WebhookRunsList({ runs }: { runs: WebhookRun[] }) {
  if (runs.length === 0) {
    return (
      <EmptyState
        icon={<Clock3 className="h-10 w-10" />}
        title="No webhook runs"
        description="Recent deliveries for this connector will appear here."
        className="py-8"
      />
    )
  }

  return (
    <>
      <div className="space-y-2 px-4 py-4 md:hidden">
        {runs.map((run) => (
          <WebhookRunCard key={run.id} run={run} />
        ))}
      </div>
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Webhook</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>HTTP</TableHead>
              <TableHead>Started</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Idempotency</TableHead>
              <TableHead className="text-right">Body</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run) => (
              <TableRow key={run.id}>
                <TableCell>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {humanizeIdentifier(run.webhookId)}
                    </p>
                    <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                      {run.id}
                    </p>
                    {run.error && (
                      <RunFailure
                        failure={run.error}
                        variant="inline"
                        className="mt-1 max-w-[260px] text-xs"
                      />
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <WebhookRunStatusBadge status={run.status} />
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {run.responseStatus ?? "-"}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {formatRelativeTime(run.startedAt)}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {webhookRunDuration(run)}
                </TableCell>
                <TableCell>
                  <WebhookRunIdempotency run={run} />
                </TableCell>
                <TableCell className="text-right font-mono text-xs text-muted-foreground">
                  {formatBytes(run.requestBodyBytes)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  )
}

function WebhookRunsSection({
  connector,
  runs,
  total,
  selectedWebhookId,
  onSelectWebhook,
  isLoading,
  isError,
  isUnrecorded,
}: {
  connector: Connector
  runs: WebhookRun[]
  total: number
  selectedWebhookId: string | null
  onSelectWebhook: (webhookId: string | null) => void
  isLoading: boolean
  isError: boolean
  isUnrecorded: boolean
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex flex-col gap-3 border-b border-border px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Clock3 className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-medium text-foreground">Recent Webhook Runs</h3>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {total} recent run{total === 1 ? "" : "s"}
          </p>
        </div>
        <WebhookFilterBar
          connector={connector}
          selectedWebhookId={selectedWebhookId}
          onSelectWebhook={onSelectWebhook}
        />
      </div>

      {isLoading ? (
        <div className="px-5 py-8">
          <div className="flex items-center gap-3 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-sm">Loading webhook runs...</span>
          </div>
        </div>
      ) : isUnrecorded ? (
        <UnrecordedHistoryState what="Webhook run history" />
      ) : isError ? (
        <EmptyState
          icon={<Clock3 className="h-10 w-10" />}
          title="Webhook runs unavailable"
          description="Could not load webhook run history."
          className="py-8"
        />
      ) : (
        <WebhookRunsList runs={runs} />
      )}
    </section>
  )
}

function ConnectorDetail({ connector }: { connector: Connector | null }) {
  const connectorId = connector?.id ?? ""
  const [selectedWebhookId, setSelectedWebhookId] = useState<string | null>(null)
  const runsQuery = useQuery({
    ...listWebhookRunsOptions({
      query: {
        connectorId,
        limit: "20",
        order: "desc",
      },
    }),
    enabled: connectorId.length > 0,
    refetchInterval(query) {
      const data = query.state.data as ListWebhookRunsResponse | undefined
      return data?.runs.some((run) => run.status === "running") ? 2000 : false
    },
  })

  useEffect(() => {
    if (!connector || selectedWebhookId === null) return
    if (!connector.webhooks.some((webhook) => webhook.id === selectedWebhookId)) {
      setSelectedWebhookId(null)
    }
  }, [connector, selectedWebhookId])

  const webhookRuns = useMemo(() => runsQuery.data?.runs ?? [], [runsQuery.data?.runs])
  const visibleWebhookRuns = useMemo(() => {
    if (!selectedWebhookId) return webhookRuns
    return webhookRuns.filter((run) => run.webhookId === selectedWebhookId)
  }, [selectedWebhookId, webhookRuns])
  const latestRunByWebhookId = useMemo(() => {
    const latest = new Map<string, WebhookRun>()
    for (const run of webhookRuns) {
      if (!latest.has(run.webhookId)) {
        latest.set(run.webhookId, run)
      }
    }
    return latest
  }, [webhookRuns])

  if (!connector) {
    return (
      <div className="rounded-lg border border-border bg-card p-8">
        <EmptyState
          icon={<Cable className="h-10 w-10" />}
          title="No connector selected"
          description="Select a connector to view its registered routes and syncs."
        />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <section className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <p className="text-sm text-muted-foreground">{connectorSummary(connector)}</p>
          <h2 className="mt-1 text-2xl font-semibold tracking-normal text-foreground">
            {connectorName(connector)}
          </h2>
        </div>

        <dl className="px-5">
          <DetailRow label="ID" value={connector.id} mono />
          <DetailRow label="Type" value={connector.type} mono />
          <DetailRow label="Outbound client" value={connector.type === "webhook" ? "No" : "Yes"} />
        </dl>

        <ConnectorSection
          icon={<Webhook className="h-4 w-4" />}
          title="Webhooks"
          empty={connector.webhooks.length === 0}
        >
          <div className="space-y-2">
            {connector.webhooks.map((webhook) => {
              const latestRun = latestRunByWebhookId.get(webhook.id)

              return (
                <div key={webhook.id}>
                  <div className="flex items-center justify-end gap-2">
                    {latestRun && <WebhookRunStatusBadge status={latestRun.status} />}
                    <p className="truncate text-sm font-medium text-foreground">
                      {humanizeIdentifier(webhook.id)}
                    </p>
                    <span className="font-mono text-xs text-muted-foreground">
                      {webhook.method}
                    </span>
                  </div>
                  <p className="break-all font-mono text-xs text-muted-foreground">
                    {webhook.route}
                  </p>
                </div>
              )
            })}
          </div>
        </ConnectorSection>

        <ConnectorSection
          icon={<GitBranch className="h-4 w-4" />}
          title="Syncs"
          empty={connector.syncIds.length === 0}
        >
          <div className="space-y-1">
            {connector.syncIds.map((syncId) => (
              <p key={syncId} className="break-all font-mono text-xs text-foreground">
                {syncId}
              </p>
            ))}
          </div>
        </ConnectorSection>
      </section>

      <WebhookRunsSection
        connector={connector}
        runs={visibleWebhookRuns}
        total={runsQuery.data?.total ?? 0}
        selectedWebhookId={selectedWebhookId}
        onSelectWebhook={setSelectedWebhookId}
        isLoading={runsQuery.isLoading}
        isError={runsQuery.isError}
        isUnrecorded={isUnconfiguredStorageError(runsQuery.error)}
      />
    </div>
  )
}

export function ConnectorsPage() {
  const { data: connectors = [], isLoading, isError } = useQuery(listConnectorsOptions())
  const navigate = useNavigate()
  const [searchQuery, setSearchQuery] = useState("")
  const [viewStyle, setViewStyle] = useState<ConnectorListViewStyle>(() =>
    getCollectionViewStyle("connectors", ["cards", "table"], "cards")
  )

  const filteredConnectors = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return connectors

    return connectors.filter((connector) => {
      return (
        connector.id.toLowerCase().includes(query) ||
        connector.type.toLowerCase().includes(query) ||
        connector.webhooks.some((webhook) => webhook.id.toLowerCase().includes(query)) ||
        connector.syncIds.some((syncId) => syncId.toLowerCase().includes(query))
      )
    })
  }, [connectors, searchQuery])

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center py-24">
        <div className="flex items-center gap-3 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Loading connectors...</span>
        </div>
      </div>
    )
  }

  if (isError) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="w-full max-w-md rounded-lg border border-border bg-card p-6">
          <EmptyState
            icon={<Cable className="h-10 w-10" />}
            title="Connectors unavailable"
            description="Could not load connector metadata."
          />
        </div>
      </div>
    )
  }

  const handleSelectConnector = (connectorId: string) => {
    navigate(`/connectors/${encodeURIComponent(connectorId)}`)
  }

  return (
    <div className="mx-auto w-full max-w-5xl">
      <CollectionHeader
        title="Connectors"
        count={filteredConnectors.length}
        actions={
          connectors.length > 0 ? (
            <CollectionViewToggle
              value={viewStyle}
              options={connectorListViewOptions}
              onChange={(style) => {
                setViewStyle(style)
                setCollectionViewStyle("connectors", style)
              }}
            />
          ) : null
        }
      />

      {connectors.length > 0 && (
        <div className="relative mt-2">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search connectors, syncs, or webhooks..."
            className="pl-9"
          />
        </div>
      )}

      <div className="mt-4">
        {connectors.length === 0 ? (
          <EmptyState
            icon={<Cable className="h-10 w-10" />}
            title="No connectors"
            description="Registered connectors will appear here."
          />
        ) : filteredConnectors.length === 0 ? (
          <EmptyState
            icon={<Search className="h-9 w-9" />}
            title="No results"
            description="Try another search."
            className="py-12"
          />
        ) : viewStyle === "table" ? (
          <ConnectorTableView connectors={filteredConnectors} onSelect={handleSelectConnector} />
        ) : (
          <CollectionCardGrid>
            {filteredConnectors.map((connector) => (
              <ConnectorListItem
                key={connector.id}
                connector={connector}
                onSelect={() => handleSelectConnector(connector.id)}
              />
            ))}
          </CollectionCardGrid>
        )}
      </div>
    </div>
  )
}

export function ConnectorDetailPage() {
  const { connectorId = "" } = useParams()
  const navigate = useNavigate()
  const decodedConnectorId = decodeURIComponent(connectorId)

  const {
    data: connector,
    isLoading,
    isError,
  } = useQuery({
    ...getConnectorOptions({
      path: { connectorId: decodedConnectorId },
    }),
    enabled: decodedConnectorId.length > 0,
  })

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center py-24">
        <div className="flex items-center gap-3 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Loading connector...</span>
        </div>
      </div>
    )
  }

  if (isError || !connector) {
    return (
      <div className="mx-auto w-full max-w-2xl space-y-4">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => navigate("/connectors")}
          className="-ml-2 text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft />
          Connectors
        </Button>
        <div className="rounded-lg border border-border bg-card p-8">
          <EmptyState
            icon={<Cable className="h-10 w-10" />}
            title="Connector not found"
            description="This connector is not registered in the active Sixb runtime."
          />
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => navigate("/connectors")}
        className="-ml-2 self-start text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft />
        Connectors
      </Button>
      <ConnectorDetail connector={connector} />
    </div>
  )
}
