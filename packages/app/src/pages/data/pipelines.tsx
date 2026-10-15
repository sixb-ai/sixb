import {
  getDatasetOptions,
  getPipelineOptions,
  getPipelineQueryKey,
  getPipelineRunOptions,
  listDatasetRowsOptions,
  listPipelineRunsOptions,
  listPipelineRunsQueryKey,
  listPipelinesOptions,
  listPipelinesQueryKey,
  requestPipelineRunMutation,
} from "@sixb/client/hooks"
import { Button, DataTable } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Database,
  History,
  Loader2,
  Play,
  Workflow,
  X,
} from "lucide-react"
import { lazy, type ReactNode, Suspense, useMemo, useState } from "react"
import { Link, useParams, useSearchParams } from "react-router-dom"
import {
  DetailFallback,
  notify,
  SectionPage,
  SectionWorkspace,
  WorkspaceHeader,
} from "../section-page"
import {
  apiErrorMessage,
  FailureSummary,
  formatDuration,
  humanize,
  IconTile,
  isUnrecorded,
  MetaDot,
  Panel,
  PanelEmpty,
  PanelRow,
  PanelSkeleton,
  Pill,
  RunStatusPill,
  UnrecordedHistory,
  useFormat,
  useLoadFailure,
  useNumbers,
  useRunStatusLabels,
} from "../section-ui"
import { datasetGridColumns } from "./datasets"
import { useDatasetLiveUpdates, usePipelineLiveUpdates } from "./live-updates"
import { useDataMessages } from "./messages"
import { ScheduleMeta } from "./shared"

/** Data › Pipelines: what turns datasets into new ones, and how each last ran. */
export function DataPipelinesPage() {
  const messages = useDataMessages()
  const format = useFormat()
  usePipelineLiveUpdates()
  const pipelinesQuery = useQuery({ ...listPipelinesOptions(), retry: false })
  const pipelines = pipelinesQuery.data ?? []

  return (
    <SectionPage
      section="data"
      page="pipelines"
      title={messages.pipelines.title}
      description={messages.pipelines.description}
    >
      <Panel>
        {pipelinesQuery.isPending ? (
          <PanelSkeleton rows={3} />
        ) : pipelinesQuery.isError ? (
          <PanelEmpty
            tone="error"
            icon={Workflow}
            title={messages.pipelines.title}
            description={apiErrorMessage(pipelinesQuery.error, messages.common.loadFailed)}
          />
        ) : pipelines.length === 0 ? (
          <PanelEmpty
            icon={Workflow}
            title={messages.pipelines.emptyTitle}
            description={messages.pipelines.emptyDescription}
          />
        ) : (
          pipelines.map((pipeline) => {
            const steps = pipeline.graph.nodes
            const output = steps.at(-1)?.step.output.id
            return (
              <PanelRow
                key={pipeline.id}
                href={`/data/pipelines/${encodeURIComponent(pipeline.id)}`}
                leading={<IconTile icon={Workflow} />}
                title={<span className="truncate">{humanize(pipeline.id)}</span>}
                meta={
                  <>
                    <span>{messages.pipelines.stepCount(steps.length)}</span>
                    {output ? (
                      <>
                        <MetaDot />
                        <span className="truncate">{messages.common.writes(output)}</span>
                      </>
                    ) : null}
                    {pipeline.triggers.map((trigger) => (
                      <ScheduleMeta key={trigger.scheduleId} id={trigger.scheduleId} />
                    ))}
                    {pipeline.latestRun ? (
                      <>
                        <MetaDot />
                        <span>
                          {format.relative(
                            pipeline.latestRun.startedAt ?? pipeline.latestRun.queuedAt
                          )}
                        </span>
                      </>
                    ) : null}
                  </>
                }
                trailing={
                  <>
                    {pipeline.latestRun ? (
                      <RunStatusPill status={pipeline.latestRun.status} />
                    ) : (
                      <Pill tone="muted">{messages.common.neverRun}</Pill>
                    )}
                    <ChevronRight className="size-4 text-muted-foreground/60" />
                  </>
                }
              />
            )
          })
        )}
      </Panel>
    </SectionPage>
  )
}

const PipelineCanvas = lazy(() => import("./pipeline-canvas"))

const previewRows = 50

/**
 * One pipeline as a canvas: its datasets and steps from left to right. A dataset opens its rows
 * below the canvas; Runs opens the run history beside it, and a run's step results colour the
 * steps.
 */
export function DataPipelinePage() {
  const pipelineId = useParams().pipelineId ?? ""
  // The open dataset and the runs panel belong to one pipeline; another starts closed.
  return <PipelineDetail key={pipelineId} pipelineId={pipelineId} />
}

function PipelineDetail({ pipelineId }: { readonly pipelineId: string }) {
  const statusLabels = useRunStatusLabels()
  const messages = useDataMessages()
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedRunParam = searchParams.get("run")
  const [runsOpen, setRunsOpen] = useState(selectedRunParam !== null)
  const [datasetId, setDatasetId] = useState<string | null>(null)
  usePipelineLiveUpdates({ pipelineId })

  const pipelineQuery = useQuery({
    ...getPipelineOptions({ path: { pipelineId } }),
    retry: false,
  })
  const pipeline = pipelineQuery.data
  const latestRun = pipeline?.latestRun ?? null
  // The canvas shows the run picked in the panel, or the latest.
  const shownRunId = selectedRunParam ?? latestRun?.id
  const runQuery = useQuery({
    ...getPipelineRunOptions({ path: { runId: shownRunId ?? "" } }),
    enabled: Boolean(shownRunId),
    retry: false,
  })
  const stepStatus = useMemo(
    () => new Map((runQuery.data?.steps ?? []).map((step) => [step.stepId, step.status])),
    [runQuery.data]
  )

  const selectRun = (runId: string | null) =>
    setSearchParams(
      (params) => {
        if (runId) params.set("run", runId)
        else params.delete("run")
        return params
      },
      { replace: true }
    )

  const request = useMutation({
    ...requestPipelineRunMutation(),
    onSuccess: async (data) => {
      notify.success(messages.pipelines.started)
      setRunsOpen(true)
      selectRun(data.runId)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getPipelineQueryKey({ path: { pipelineId } }) }),
        queryClient.invalidateQueries({ queryKey: listPipelinesQueryKey() }),
        queryClient.invalidateQueries({ queryKey: listPipelineRunsQueryKey() }),
      ])
    },
    onError: (error) => notify.error(apiErrorMessage(error, messages.pipelines.requestFailed)),
  })

  const back = { href: "/data/pipelines", label: messages.pipelines.title }

  if (!pipeline) {
    return (
      <DetailFallback
        section="data"
        page="pipelines"
        back={back}
        name={humanize(pipelineId)}
        id={pipelineId}
        icon={Workflow}
        error={pipelineQuery.error}
      />
    )
  }

  const running = latestRun?.status === "queued" || latestRun?.status === "running"

  return (
    <SectionWorkspace section="data" page="pipelines">
      <WorkspaceHeader
        back={back}
        icon={<IconTile icon={Workflow} />}
        title={humanize(pipeline.id)}
        meta={
          <>
            {latestRun ? (
              <RunStatusPill status={latestRun.status} />
            ) : (
              <Pill tone="muted">{messages.common.neverRun}</Pill>
            )}
            <span>{messages.pipelines.stepCount(pipeline.graph.nodes.length)}</span>
            {pipeline.triggers.map((trigger) => (
              <ScheduleMeta key={trigger.scheduleId} id={trigger.scheduleId} />
            ))}
          </>
        }
        actions={
          <>
            <Button
              type="button"
              variant={runsOpen ? "secondary" : "ghost"}
              size="sm"
              aria-expanded={runsOpen}
              onClick={() => {
                // Closing the panel goes back to the latest run, as its close button does.
                if (runsOpen) selectRun(null)
                setRunsOpen(!runsOpen)
              }}
            >
              <History />
              <span className="hidden sm:inline">{messages.common.runs}</span>
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={request.isPending || running}
              onClick={() => request.mutate({ path: { pipelineId } })}
            >
              {request.isPending || running ? <Loader2 className="animate-spin" /> : <Play />}
              {request.isPending
                ? messages.pipelines.starting
                : running
                  ? statusLabels.running
                  : messages.pipelines.runNow}
            </Button>
          </>
        }
      />

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1 bg-muted/25">
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-[0.8125rem] text-muted-foreground">
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  {messages.pipelines.canvasLoading}
                </div>
              }
            >
              <PipelineCanvas
                pipeline={pipeline}
                stepStatus={stepStatus}
                selectedDatasetId={datasetId}
                onSelectDataset={setDatasetId}
              />
            </Suspense>
            {datasetId === null ? (
              <p className="pointer-events-none absolute bottom-4 left-1/2 hidden -translate-x-1/2 rounded-md bg-background/80 px-2 py-1 text-xs text-muted-foreground backdrop-blur-sm sm:block">
                {messages.pipelines.canvasHint}
              </p>
            ) : null}
          </div>
          <DatasetDrawer datasetId={datasetId} onClose={() => setDatasetId(null)} />
        </div>

        <aside
          aria-hidden={!runsOpen}
          className={cn(
            "h-full shrink-0 overflow-hidden border-border bg-card transition-[width] duration-300 ease-out",
            runsOpen ? "w-[22rem] max-w-[calc(100vw-1rem)] border-l" : "w-0"
          )}
        >
          <div className="flex h-full w-[22rem] max-w-[calc(100vw-1rem)] flex-col">
            {runsOpen ? (
              selectedRunParam ? (
                <RunPanel
                  runId={selectedRunParam}
                  onBack={() => selectRun(null)}
                  onClose={() => {
                    setRunsOpen(false)
                    selectRun(null)
                  }}
                  onOpenDataset={setDatasetId}
                />
              ) : (
                <RunsPanel
                  pipelineId={pipelineId}
                  onSelect={selectRun}
                  onClose={() => setRunsOpen(false)}
                />
              )
            ) : null}
          </div>
        </aside>
      </div>
    </SectionWorkspace>
  )
}

function PanelBar({
  title,
  onBack,
  onClose,
  children,
}: {
  readonly title: ReactNode
  readonly onBack?: () => void
  readonly onClose: () => void
  readonly children?: ReactNode
}) {
  const messages = useDataMessages().pipelines
  return (
    <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-border px-2.5">
      {onBack ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onBack}
          aria-label={messages.allRuns}
        >
          <ChevronLeft />
        </Button>
      ) : null}
      <h2 className="min-w-0 truncate pl-1 text-sm font-semibold">{title}</h2>
      {children}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={onClose}
        aria-label={messages.close}
        className="ml-auto"
      >
        <X />
      </Button>
    </div>
  )
}

function RunsPanel({
  pipelineId,
  onSelect,
  onClose,
}: {
  readonly pipelineId: string
  readonly onSelect: (runId: string) => void
  readonly onClose: () => void
}) {
  const messages = useDataMessages()
  const format = useFormat()
  const runsQuery = useQuery({
    ...listPipelineRunsOptions({ query: { pipelineId, limit: "20", order: "desc" } }),
    retry: false,
  })

  return (
    <>
      <PanelBar title={messages.common.runs} onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {runsQuery.isPending ? (
          <PanelSkeleton rows={4} />
        ) : runsQuery.isError ? (
          isUnrecorded(runsQuery.error) ? (
            <UnrecordedHistory what={messages.pipelines.runWhat} />
          ) : (
            <PanelEmpty
              tone="error"
              icon={History}
              title={messages.common.runs}
              description={apiErrorMessage(runsQuery.error, messages.common.loadFailed)}
            />
          )
        ) : runsQuery.data.runs.length === 0 ? (
          <PanelEmpty
            icon={History}
            title={messages.common.noRunsTitle}
            description={messages.pipelines.runsEmpty}
          />
        ) : (
          <ul className="divide-y divide-border">
            {runsQuery.data.runs.map((run) => (
              // The failure sits outside the row's button: its Details dialog has buttons of its
              // own, and clicks inside it would otherwise select the run.
              <li key={run.id} className="transition-colors hover:bg-muted/50">
                <button
                  type="button"
                  onClick={() => onSelect(run.id)}
                  className={cn(
                    "flex w-full items-start gap-3 px-4 pt-3 text-left",
                    run.error ? "pb-1.5" : "pb-3"
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-[0.8125rem] font-medium">
                      {format.dateTime(run.startedAt ?? run.queuedAt)}
                    </span>
                    <span className="block text-xs text-muted-foreground tabular-nums">
                      {format.relative(run.startedAt ?? run.queuedAt)}
                      {run.finishedAt
                        ? ` · ${formatDuration(run.startedAt, run.finishedAt)}`
                        : null}
                    </span>
                  </span>
                  <RunStatusPill status={run.status} />
                </button>
                {run.error ? (
                  <div className="px-4 pb-3">
                    <FailureSummary failure={run.error} compact />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  )
}

function RunPanel({
  runId,
  onBack,
  onClose,
  onOpenDataset,
}: {
  readonly runId: string
  readonly onBack: () => void
  readonly onClose: () => void
  readonly onOpenDataset: (datasetId: string) => void
}) {
  const messages = useDataMessages()
  const format = useFormat()
  const numbers = useNumbers()
  const runQuery = useQuery({ ...getPipelineRunOptions({ path: { runId } }), retry: false })
  const failure = useLoadFailure(runQuery.error, { id: runId })
  const run = runQuery.data?.run
  const steps = runQuery.data?.steps ?? []

  return (
    <>
      <PanelBar
        title={run ? format.dateTime(run.startedAt ?? run.queuedAt) : messages.pipelines.run}
        onBack={onBack}
        onClose={onClose}
      >
        {run ? <RunStatusPill status={run.status} /> : null}
      </PanelBar>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {runQuery.isPending ? (
          <PanelSkeleton rows={3} />
        ) : runQuery.isError || !run ? (
          <PanelEmpty
            tone="error"
            icon={History}
            title={failure.title}
            description={failure.description}
          />
        ) : (
          <div className="flex flex-col gap-5 p-4">
            <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border">
              {[
                [messages.common.started, format.relative(run.startedAt ?? run.queuedAt)],
                [messages.common.took, formatDuration(run.startedAt, run.finishedAt)],
              ].map(([label, value]) => (
                <div key={label} className="bg-card px-3 py-2">
                  <dt className="text-[0.6875rem] text-muted-foreground">{label}</dt>
                  <dd className="text-[0.8125rem] font-medium tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
            {run.error ? <FailureSummary failure={run.error} /> : null}
            <section className="flex flex-col gap-2">
              <h3 className="text-xs font-medium text-muted-foreground">
                {messages.pipelines.stepCount(steps.length)}
              </h3>
              {steps.length === 0 ? (
                <p className="text-[0.8125rem] text-muted-foreground">
                  {messages.pipelines.noStepsRecorded}
                </p>
              ) : (
                <ol className="flex flex-col gap-2">
                  {steps.map((step) => {
                    const output = step.output
                    return (
                      <li key={step.id} className="rounded-lg border border-border px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-[0.8125rem] font-medium">
                            {humanize(step.stepId)}
                          </span>
                          <RunStatusPill status={step.status} />
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground tabular-nums">
                          <span>{messages.common.modes[step.mode]}</span>
                          {step.rowsWritten !== undefined ? (
                            <>
                              <MetaDot />
                              <span>
                                {messages.pipelines.rowsWritten(
                                  step.rowsWritten,
                                  numbers.count(step.rowsWritten)
                                )}
                              </span>
                            </>
                          ) : null}
                          {step.finishedAt ? (
                            <>
                              <MetaDot />
                              <span>{formatDuration(step.startedAt, step.finishedAt)}</span>
                            </>
                          ) : null}
                        </div>
                        {output ? (
                          <button
                            type="button"
                            onClick={() => onOpenDataset(output.datasetId)}
                            className="mt-2 inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-background px-2 py-0.5 font-mono text-xs transition-colors hover:border-foreground/25"
                          >
                            <Database className="size-3 shrink-0 text-muted-foreground" />
                            <span className="truncate">{output.datasetId}</span>
                          </button>
                        ) : null}
                        {step.error ? (
                          <div className="mt-2">
                            <FailureSummary failure={step.error} compact />
                          </div>
                        ) : null}
                      </li>
                    )
                  })}
                </ol>
              )}
            </section>
          </div>
        )}
      </div>
    </>
  )
}

/** A dataset's first rows, below the canvas, with the way to its full page. */
function DatasetDrawer({
  datasetId,
  onClose,
}: {
  readonly datasetId: string | null
  readonly onClose: () => void
}) {
  const open = datasetId !== null
  return (
    <div
      aria-hidden={!open}
      className={cn(
        "shrink-0 overflow-hidden transition-[height] duration-300 ease-out",
        open ? "h-[46%] min-h-64" : "h-0"
      )}
    >
      {datasetId ? <DatasetPreview datasetId={datasetId} onClose={onClose} /> : null}
    </div>
  )
}

function DatasetPreview({
  datasetId,
  onClose,
}: {
  readonly datasetId: string
  readonly onClose: () => void
}) {
  const messages = useDataMessages()
  const format = useFormat()
  const numbers = useNumbers()
  useDatasetLiveUpdates({ datasetId })
  const datasetQuery = useQuery({ ...getDatasetOptions({ path: { datasetId } }), retry: false })
  const hasVersion = Boolean(datasetQuery.data?.latestVersion)
  const rowsQuery = useQuery({
    ...listDatasetRowsOptions({ path: { datasetId }, query: { limit: String(previewRows) } }),
    enabled: hasVersion,
    retry: false,
  })
  const dataset = datasetQuery.data
  const page = rowsQuery.data
  const schemaColumns = page?.version.schema.columns ?? dataset?.schema.columns ?? []
  const types = useMemo(
    () => new Map(schemaColumns.map((column) => [column.name, column.type])),
    [schemaColumns]
  )
  const names = page?.columns ?? schemaColumns.map((column) => column.name)
  const columns = useMemo(
    () => datasetGridColumns(names, types, page?.redactions, messages.datasets.hidden),
    [names, types, page?.redactions, messages.datasets.hidden]
  )
  const version = page?.version ?? dataset?.latestVersion
  const rows = page?.rows ?? []

  return (
    <div className="flex h-full flex-col border-t border-border bg-card">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-3 md:px-4">
        <IconTile icon={Database} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-[0.8125rem] font-semibold">{datasetId}</p>
          <p className="truncate text-xs text-muted-foreground tabular-nums">
            {version?.rowCount !== undefined
              ? `${messages.common.rows(version.rowCount, numbers.count(version.rowCount))} · `
              : null}
            {messages.common.columns(schemaColumns.length)}
            {version ? ` · ${messages.datasets.updated(format.relative(version.createdAt))}` : null}
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" asChild>
          <Link to={`/data/datasets/${encodeURIComponent(datasetId)}`}>
            {messages.pipelines.openDataset}
            <ArrowUpRight />
          </Link>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label={messages.pipelines.close}
        >
          <X />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {datasetQuery.isError || rowsQuery.isError ? (
          <PanelEmpty
            tone="error"
            icon={Database}
            title={messages.datasets.rowsUnavailable}
            description={apiErrorMessage(
              datasetQuery.error ?? rowsQuery.error,
              messages.common.loadFailed
            )}
          />
        ) : datasetQuery.isSuccess && !hasVersion ? (
          <PanelEmpty
            icon={Database}
            title={messages.datasets.noVersionsTitle}
            description={messages.datasets.noVersionsDescription}
          />
        ) : (
          <DataTable
            columns={columns}
            data={rows}
            showRowIndex
            isLoading={datasetQuery.isPending || rowsQuery.isPending}
            empty={
              <PanelEmpty
                icon={Database}
                title={messages.datasets.noRowsTitle}
                description={messages.datasets.noRowsDescription}
              />
            }
          />
        )}
      </div>
      {page?.hasMore ? (
        <p className="shrink-0 border-t border-border px-3 py-1.5 text-xs text-muted-foreground md:px-4">
          {messages.pipelines.previewLimited(numbers.count(previewRows))}
        </p>
      ) : null}
    </div>
  )
}
