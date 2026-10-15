import {
  listActionRunsInfiniteOptions,
  listActionsOptions,
  listConnectorsOptions,
  listPipelineRunsInfiniteOptions,
  listPipelinesOptions,
  listProjectionRunsInfiniteOptions,
  listProjectionsOptions,
  listSyncRunsInfiniteOptions,
  listSyncsOptions,
  listWebhookRunsInfiniteOptions,
  listWorkflowRunsInfiniteOptions,
  listWorkflowsOptions,
} from "@sixb/client/hooks"
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@sixb/ui/components"
import { type InfiniteData, useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { ChevronRight, Layers, Loader2, RefreshCw, Webhook, Workflow, Zap } from "lucide-react"
import type { ComponentType, ReactNode } from "react"
import { useSearchParams } from "react-router-dom"
import { usePipelineLiveUpdates, useSyncLiveUpdates } from "../data/live-updates"
import { actionRunHref, workflowRunHref } from "../routes"
import { SectionPage } from "../section-page"
import {
  formatDuration,
  humanize,
  IconTile,
  isUnrecorded,
  MetaDot,
  Panel,
  PanelEmpty,
  PanelRow,
  PanelSkeleton,
  type RunStatus,
  RunStatusPill,
  ToolbarTabs,
  UnrecordedHistory,
  useFormat,
  useLoadFailure,
  useNumbers,
  useRunStatusLabels,
} from "../section-ui"
import { useWorkflowRunLiveUpdates } from "./live-updates"
import { useObservabilityMessages } from "./messages"

type Icon = ComponentType<{ readonly className?: string }>

const kinds = ["workflows", "actions", "syncs", "pipelines", "projections", "webhooks"] as const
type Kind = (typeof kinds)[number]

/** Each kind's filter in the URL, named after what it picks: `?kind=syncs&sync=crm-deals`. */
const definitionParams: Record<Kind, string> = {
  workflows: "workflow",
  actions: "action",
  syncs: "sync",
  pipelines: "pipeline",
  projections: "projection",
  webhooks: "connector",
}

const pageSize = 20
// Runs that publish no events are read again while their list is open, every loaded page with them.
const pollMs = 10_000

const workflowStatuses = [
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
] as const
const dataStatuses = ["queued", "running", "succeeded", "failed", "cancelled"] as const
const projectionStatuses = [...dataStatuses, "superseded"] as const
const actionStatuses = ["succeeded", "failed"] as const
const webhookStatuses = ["running", "succeeded", "failed"] as const

/**
 * Observability › Runs: every run the project records, a tab per kind, newest first, filtered by
 * what ran and how it went. Workflow and action runs open their own pages; a sync, pipeline,
 * projection or webhook run opens the Data page that shows it.
 */
export function ObservabilityRunsPage() {
  const messages = useObservabilityMessages().runs
  const [searchParams, setSearchParams] = useSearchParams()
  const kind = pick(kinds, searchParams.get("kind")) ?? "workflows"

  // One update per change: separate calls in one event would each start from the same URL.
  const setFilter = (changes: Readonly<Record<string, string | null>>) =>
    setSearchParams(
      (params) => {
        for (const [name, value] of Object.entries(changes)) {
          if (value) params.set(name, value)
          else params.delete(name)
        }
        return params
      },
      { replace: true }
    )
  const props: RunListProps = {
    definition: searchParams.get(definitionParams[kind]),
    status: searchParams.get("status"),
    onDefinition: (value) => setFilter({ [definitionParams[kind]]: value }),
    onStatus: (value) => setFilter({ status: value }),
    tabs: (
      <ToolbarTabs
        value={kind}
        // Each kind has its own definitions and statuses, so its filters start clear.
        onChange={(next) =>
          setFilter({
            kind: next === "workflows" ? null : next,
            status: null,
            ...Object.fromEntries(Object.values(definitionParams).map((name) => [name, null])),
          })
        }
        tabs={kinds.map((id) => ({ id, label: messages.kinds[id] }))}
      />
    ),
  }

  return (
    <SectionPage
      section="observability"
      page="runs"
      width="wide"
      title={messages.title}
      description={messages.description}
    >
      {kind === "workflows" ? (
        <WorkflowRuns {...props} />
      ) : kind === "actions" ? (
        <ActionRuns {...props} />
      ) : kind === "syncs" ? (
        <SyncRuns {...props} />
      ) : kind === "pipelines" ? (
        <PipelineRuns {...props} />
      ) : kind === "projections" ? (
        <ProjectionRuns {...props} />
      ) : (
        <WebhookRuns {...props} />
      )}
    </SectionPage>
  )
}

interface RunListProps {
  readonly definition: string | null
  readonly status: string | null
  readonly onDefinition: (value: string | null) => void
  readonly onStatus: (value: string | null) => void
  /** The kind tabs, shown in the list's toolbar. */
  readonly tabs: ReactNode
}

/** A list's filters, newest first, a page at a time. */
function listQuery<TStatus extends string>(
  definitionKey: string,
  definition: string | null,
  status: TStatus | null
) {
  return {
    limit: String(pageSize),
    order: "desc" as const,
    ...(definition ? { [definitionKey]: definition } : {}),
    ...(status ? { status } : {}),
  }
}

// Each next page starts where the loaded runs end.
const paging = {
  initialPageParam: "0",
  getNextPageParam: (
    lastPage: { readonly hasMore: boolean },
    pages: readonly { readonly runs: readonly unknown[] }[]
  ) =>
    lastPage.hasMore ? String(pages.reduce((sum, page) => sum + page.runs.length, 0)) : undefined,
  retry: false,
} as const

function pick<T extends string>(values: readonly T[], value: string | null): T | null {
  return values.find((candidate) => candidate === value) ?? null
}

function WorkflowRuns({ definition, status, onDefinition, onStatus, tabs }: RunListProps) {
  const messages = useObservabilityMessages().runs
  useWorkflowRunLiveUpdates()
  const workflows = useQuery({ ...listWorkflowsOptions(), retry: false }).data ?? []
  const shownStatus = pick(workflowStatuses, status)
  const query = useInfiniteQuery({
    ...listWorkflowRunsInfiniteOptions({
      query: listQuery("workflowId", definition, shownStatus),
    }),
    ...paging,
  })
  return (
    <RunList
      tabs={tabs}
      filters={
        <Filters
          definitions={workflows.map((workflow) => workflow.id)}
          definition={definition}
          allDefinitions={messages.all.workflows}
          onDefinition={onDefinition}
          statuses={workflowStatuses}
          status={shownStatus}
          onStatus={onStatus}
        />
      }
      query={query}
      filtered={Boolean(definition || shownStatus)}
      empty={messages.empty.workflows}
      unrecorded={messages.unrecorded.workflows}
      icon={Workflow}
      row={(run) => (
        <RunRow
          key={run.id}
          href={workflowRunHref(run.id)}
          icon={Workflow}
          title={humanize(run.workflowId)}
          at={run.startedAt ?? run.queuedAt}
          run={run}
        />
      )}
    />
  )
}

function ActionRuns({ definition, status, onDefinition, onStatus, tabs }: RunListProps) {
  const messages = useObservabilityMessages().runs
  const actions = useQuery({ ...listActionsOptions(), retry: false }).data ?? []
  const shownStatus = pick(actionStatuses, status)
  const query = useInfiniteQuery({
    ...listActionRunsInfiniteOptions({ query: listQuery("actionId", definition, shownStatus) }),
    ...paging,
    refetchInterval: pollMs,
  })
  return (
    <RunList
      tabs={tabs}
      filters={
        <Filters
          definitions={actions.map((action) => action.id)}
          definition={definition}
          allDefinitions={messages.all.actions}
          onDefinition={onDefinition}
          statuses={actionStatuses}
          status={shownStatus}
          onStatus={onStatus}
        />
      }
      query={query}
      filtered={Boolean(definition || shownStatus)}
      empty={messages.empty.actions}
      unrecorded={messages.unrecorded.actions}
      icon={Zap}
      row={(run) => (
        <RunRow
          key={run.id}
          href={actionRunHref(run.id)}
          icon={Zap}
          title={humanize(run.actionId)}
          at={run.startedAt}
          run={run}
          detail={
            run.subject.kind === "none" ? (
              <span>{messages.noSubject}</span>
            ) : (
              <span className="min-w-0 truncate font-mono text-xs">
                {run.subject.objectTypeId} · {run.subject.primaryId}
              </span>
            )
          }
        />
      )}
    />
  )
}

function SyncRuns({ definition, status, onDefinition, onStatus, tabs }: RunListProps) {
  const messages = useObservabilityMessages().runs
  const numbers = useNumbers()
  useSyncLiveUpdates()
  const syncs = useQuery({ ...listSyncsOptions(), retry: false }).data ?? []
  const shownStatus = pick(dataStatuses, status)
  const query = useInfiniteQuery({
    ...listSyncRunsInfiniteOptions({ query: listQuery("syncId", definition, shownStatus) }),
    ...paging,
  })
  return (
    <RunList
      tabs={tabs}
      filters={
        <Filters
          definitions={syncs.map((sync) => sync.id)}
          definition={definition}
          allDefinitions={messages.all.syncs}
          onDefinition={onDefinition}
          statuses={dataStatuses}
          status={shownStatus}
          onStatus={onStatus}
        />
      }
      query={query}
      filtered={Boolean(definition || shownStatus)}
      empty={messages.empty.syncs}
      unrecorded={messages.unrecorded.syncs}
      icon={RefreshCw}
      row={(run) => (
        <RunRow
          key={run.id}
          href={`/data/syncs/${encodeURIComponent(run.syncId)}`}
          icon={RefreshCw}
          title={humanize(run.syncId)}
          at={run.startedAt ?? run.queuedAt}
          run={run}
          detail={
            run.rowsRead === undefined ? null : (
              <span className="tabular-nums">
                {messages.rowsRead(run.rowsRead, numbers.count(run.rowsRead))}
              </span>
            )
          }
        />
      )}
    />
  )
}

function PipelineRuns({ definition, status, onDefinition, onStatus, tabs }: RunListProps) {
  const messages = useObservabilityMessages().runs
  usePipelineLiveUpdates()
  const pipelines = useQuery({ ...listPipelinesOptions(), retry: false }).data ?? []
  const shownStatus = pick(dataStatuses, status)
  const query = useInfiniteQuery({
    ...listPipelineRunsInfiniteOptions({
      query: listQuery("pipelineId", definition, shownStatus),
    }),
    ...paging,
  })
  return (
    <RunList
      tabs={tabs}
      filters={
        <Filters
          definitions={pipelines.map((pipeline) => pipeline.id)}
          definition={definition}
          allDefinitions={messages.all.pipelines}
          onDefinition={onDefinition}
          statuses={dataStatuses}
          status={shownStatus}
          onStatus={onStatus}
        />
      }
      query={query}
      filtered={Boolean(definition || shownStatus)}
      empty={messages.empty.pipelines}
      unrecorded={messages.unrecorded.pipelines}
      icon={Workflow}
      row={(run) => (
        <RunRow
          key={run.id}
          // The pipeline's page opens on this run, its steps coloured by how they went.
          href={`/data/pipelines/${encodeURIComponent(run.pipelineId)}?run=${encodeURIComponent(run.id)}`}
          icon={Workflow}
          title={humanize(run.pipelineId)}
          at={run.startedAt ?? run.queuedAt}
          run={run}
        />
      )}
    />
  )
}

function ProjectionRuns({ definition, status, onDefinition, onStatus, tabs }: RunListProps) {
  const messages = useObservabilityMessages().runs
  const numbers = useNumbers()
  const data = useQuery({ ...listProjectionsOptions(), retry: false }).data
  const projections = data
    ? [...data.objectProjections, ...data.linkProjections, ...data.telemetryProjections]
    : []
  const shownStatus = pick(projectionStatuses, status)
  const query = useInfiniteQuery({
    ...listProjectionRunsInfiniteOptions({
      query: listQuery("projectionId", definition, shownStatus),
    }),
    ...paging,
    refetchInterval: pollMs,
  })
  return (
    <RunList
      tabs={tabs}
      filters={
        <Filters
          definitions={projections.map((projection) => projection.id)}
          definition={definition}
          allDefinitions={messages.all.projections}
          onDefinition={onDefinition}
          statuses={projectionStatuses}
          status={shownStatus}
          onStatus={onStatus}
        />
      }
      query={query}
      filtered={Boolean(definition || shownStatus)}
      empty={messages.empty.projections}
      unrecorded={messages.unrecorded.projections}
      icon={Layers}
      row={(run) => (
        <RunRow
          key={run.id}
          href={`/data/projections/${encodeURIComponent(run.identity.projectionId)}`}
          icon={Layers}
          title={humanize(run.identity.projectionId)}
          at={run.startedAt ?? run.queuedAt}
          run={run}
          detail={
            <span className="tabular-nums">
              {messages.rowsRead(
                run.progress.sourceRowsRead,
                numbers.count(run.progress.sourceRowsRead)
              )}
            </span>
          }
        />
      )}
    />
  )
}

function WebhookRuns({ definition, status, onDefinition, onStatus, tabs }: RunListProps) {
  const messages = useObservabilityMessages().runs
  const connectors = useQuery({ ...listConnectorsOptions(), retry: false }).data ?? []
  const shownStatus = pick(webhookStatuses, status)
  const query = useInfiniteQuery({
    ...listWebhookRunsInfiniteOptions({
      query: listQuery("connectorId", definition, shownStatus),
    }),
    ...paging,
    refetchInterval: pollMs,
  })
  return (
    <RunList
      tabs={tabs}
      filters={
        <Filters
          definitions={connectors
            .filter((connector) => connector.webhooks.length > 0)
            .map((connector) => connector.id)}
          definition={definition}
          allDefinitions={messages.all.webhooks}
          onDefinition={onDefinition}
          statuses={webhookStatuses}
          status={shownStatus}
          onStatus={onStatus}
        />
      }
      query={query}
      filtered={Boolean(definition || shownStatus)}
      empty={messages.empty.webhooks}
      unrecorded={messages.unrecorded.webhooks}
      icon={Webhook}
      row={(run) => (
        <RunRow
          key={run.id}
          href={`/data/connectors/${encodeURIComponent(run.connectorId)}`}
          icon={Webhook}
          title={humanize(run.webhookId)}
          at={run.startedAt}
          run={run}
          detail={
            <>
              <span>{humanize(run.connectorId)}</span>
              {run.responseStatus === undefined ? null : (
                <>
                  <MetaDot />
                  <span className="tabular-nums">{messages.responded(run.responseStatus)}</span>
                </>
              )}
            </>
          }
        />
      )}
    />
  )
}

/** One run: what ran, when, for how long, what went wrong, and how it ended. */
function RunRow({
  href,
  icon,
  title,
  at,
  run,
  detail,
}: {
  readonly href: string
  readonly icon: Icon
  readonly title: string
  /** When it started, or when it was queued if it has not. */
  readonly at: string | undefined
  readonly run: {
    readonly status: RunStatus
    readonly startedAt?: string
    readonly finishedAt?: string
    readonly error?: { readonly message: string }
  }
  /** Facts of this kind of run, first on the second line. */
  readonly detail?: ReactNode
}) {
  const format = useFormat()
  return (
    <PanelRow
      href={href}
      leading={<IconTile icon={icon} />}
      title={<span className="truncate">{title}</span>}
      meta={
        <>
          {detail ? (
            <>
              {detail}
              <MetaDot />
            </>
          ) : null}
          {at ? <span>{format.relative(at)}</span> : null}
          {run.finishedAt ? (
            <>
              <MetaDot />
              <span className="tabular-nums">{formatDuration(run.startedAt, run.finishedAt)}</span>
            </>
          ) : null}
          {run.error ? (
            <>
              <MetaDot />
              <span className="min-w-0 truncate text-red-600 dark:text-red-400">
                {run.error.message}
              </span>
            </>
          ) : null}
        </>
      }
      trailing={
        <>
          <RunStatusPill status={run.status} />
          <ChevronRight className="size-4 text-muted-foreground/60" />
        </>
      }
    />
  )
}

function Filters({
  definitions,
  definition,
  allDefinitions,
  onDefinition,
  statuses,
  status,
  onStatus,
}: {
  readonly definitions: readonly string[]
  readonly definition: string | null
  readonly allDefinitions: string
  readonly onDefinition: (value: string | null) => void
  readonly statuses: readonly RunStatus[]
  readonly status: string | null
  readonly onStatus: (value: string | null) => void
}) {
  const messages = useObservabilityMessages().runs
  const statusLabels = useRunStatusLabels()
  return (
    <div className="flex items-center gap-2">
      <Select
        value={definition ?? "all"}
        onValueChange={(value) => onDefinition(value === "all" ? null : value)}
      >
        <SelectTrigger size="sm" className="h-7 w-40 text-xs" aria-label={allDefinitions}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" align="end">
          <SelectItem value="all" className="text-xs">
            {allDefinitions}
          </SelectItem>
          {/* A link can name one the project no longer defines; it still shows as chosen. */}
          {definition && !definitions.includes(definition) ? (
            <SelectItem value={definition} className="text-xs">
              {humanize(definition)}
            </SelectItem>
          ) : null}
          {definitions.map((id) => (
            <SelectItem key={id} value={id} className="text-xs">
              {humanize(id)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={status ?? "all"}
        onValueChange={(value) => onStatus(value === "all" ? null : value)}
      >
        <SelectTrigger size="sm" className="h-7 w-32 text-xs" aria-label={messages.allStatuses}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" align="end">
          <SelectItem value="all" className="text-xs">
            {messages.allStatuses}
          </SelectItem>
          {statuses.map((value) => (
            <SelectItem key={value} value={value} className="text-xs">
              {statusLabels[value]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

interface RunPage<TRun> {
  readonly runs: readonly TRun[]
  readonly hasMore: boolean
  readonly total: number
}

function RunList<TRun extends { readonly id: string }>({
  tabs,
  filters,
  query,
  filtered,
  empty,
  unrecorded,
  icon,
  row,
}: {
  readonly tabs: ReactNode
  readonly filters: ReactNode
  readonly query: {
    readonly data: InfiniteData<RunPage<TRun>> | undefined
    readonly isPending: boolean
    readonly isError: boolean
    readonly error: unknown
    readonly isFetchNextPageError: boolean
    readonly hasNextPage: boolean
    readonly isFetchingNextPage: boolean
    readonly fetchNextPage: () => unknown
  }
  readonly filtered: boolean
  readonly empty: string
  /** What the history is called when nothing records it, such as "Sync runs". */
  readonly unrecorded: string
  readonly icon: Icon
  readonly row: (run: TRun) => ReactNode
}) {
  const messages = useObservabilityMessages().runs
  const numbers = useNumbers()
  const failure = useLoadFailure(query.error, { fallback: messages.loadFailed })
  // Pages are read by offset from the newest, so runs that start between two reads shift the next
  // page onto runs already shown; each run is listed once.
  const runs = [
    ...new Map(
      (query.data?.pages.flatMap((page) => page.runs) ?? []).map((run) => [run.id, run])
    ).values(),
  ]
  const total = query.data?.pages[0]?.total ?? 0

  return (
    <Panel
      toolbar={
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          {tabs}
          {filters}
        </div>
      }
      footer={
        runs.length > 0 && total > 0 ? (
          <div className="flex items-center justify-between gap-3">
            <span className="tabular-nums">
              {query.isError ? (
                <span className="text-red-600 dark:text-red-400">
                  {query.isFetchNextPageError ? messages.moreFailed : messages.refreshFailed}
                </span>
              ) : (
                messages.shown(numbers.count(runs.length), numbers.count(total))
              )}
            </span>
            {query.hasNextPage ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="-my-1"
                disabled={query.isFetchingNextPage}
                onClick={() => query.fetchNextPage()}
              >
                {query.isFetchingNextPage ? <Loader2 className="animate-spin" /> : null}
                {messages.loadMore}
              </Button>
            ) : null}
          </div>
        ) : undefined
      }
    >
      {query.isPending ? (
        <PanelSkeleton rows={4} />
      ) : query.isError && runs.length === 0 ? (
        isUnrecorded(query.error) ? (
          <UnrecordedHistory what={unrecorded} />
        ) : (
          <PanelEmpty
            tone="error"
            icon={icon}
            title={failure.title}
            description={failure.description}
          />
        )
      ) : runs.length === 0 ? (
        <PanelEmpty
          icon={icon}
          title={filtered ? messages.noMatchTitle : messages.emptyTitle}
          description={filtered ? messages.noMatch : empty}
        />
      ) : (
        runs.map(row)
      )}
    </Panel>
  )
}
