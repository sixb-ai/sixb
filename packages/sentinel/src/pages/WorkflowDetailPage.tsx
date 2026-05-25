import { getWorkflowOptions, listWorkflowRunsInfiniteOptions } from "@pario/client/hooks"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@pario/ui/components"
import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { CalendarClock, GitBranch, History, Play, Webhook } from "lucide-react"
import type { Ref } from "react"
import { useEffect, useMemo, useRef } from "react"
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom"
import { ErrorPage, LoadingInline, LoadingPage, PageFrame } from "../components/common"
import { SchemaShape } from "../features/workflows/components/nodes/SchemaShape"
import { WorkflowNodeRow } from "../features/workflows/components/nodes/WorkflowNodeRow"
import { RequestWorkflowRunDialog } from "../features/workflows/components/RequestWorkflowRunDialog"
import { RunHistoryTable } from "../features/workflows/components/runs/RunHistoryTable"
import { StatusBadge } from "../features/workflows/components/runs/StatusBadge"
import {
  allWorkflowRunStatuses,
  isWorkflowRunStatus,
  RUN_HISTORY_PAGE_SIZE,
  runTimeLabel,
  statusLabels,
  type WorkflowDetail,
  type WorkflowRunStatusFilter,
} from "../features/workflows/utils/workflows"

type WorkflowTrigger = WorkflowDetail["triggers"][number]
type WorkflowTab = "definition" | "runs"

export function WorkflowDetailPage() {
  const { workflowId = "" } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const workflowQuery = useQuery({
    ...getWorkflowOptions({ path: { workflowId } }),
    enabled: workflowId.length > 0,
  })

  if (!workflowId) {
    return <Navigate to="/" replace />
  }

  if (workflowQuery.isLoading) {
    return <LoadingPage label="Loading workflow..." />
  }

  if (workflowQuery.isError || !workflowQuery.data) {
    return (
      <ErrorPage title="Workflow unavailable" description="Could not load workflow metadata." />
    )
  }

  const workflow = workflowQuery.data
  const nodeCount = workflow.nodes.length
  const triggerCount = workflow.triggers.length
  const inputFieldCount = Object.keys(workflow.input ?? {}).length

  const activeTab: WorkflowTab = searchParams.get("tab") === "runs" ? "runs" : "definition"
  const onTabChange = (next: string) => {
    const params = new URLSearchParams(searchParams)
    if (next === "definition") {
      params.delete("tab")
    } else {
      params.set("tab", next)
    }
    setSearchParams(params)
  }

  return (
    <PageFrame
      title={workflow.id}
      description={
        <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
          <Stat count={nodeCount} singular="node" plural="nodes" />
          <Separator />
          <Stat count={triggerCount} singular="trigger" plural="triggers" />
          <Separator />
          <Stat count={inputFieldCount} singular="input field" plural="input fields" />
        </span>
      }
      backTo="/"
      backLabel="Workflows"
      actions={<RequestWorkflowRunDialog workflow={workflow} />}
    >
      <LatestRunBanner workflow={workflow} />

      <Tabs value={activeTab} onValueChange={onTabChange} className="gap-4">
        <TabsList variant="line" className="border-b border-border">
          <TabsTrigger value="definition">Definition</TabsTrigger>
          <TabsTrigger value="runs">Runs</TabsTrigger>
        </TabsList>

        <TabsContent value="definition">
          <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="space-y-3">
              <WorkflowInputCard fields={workflow.input} />

              {nodeCount === 0 ? (
                <Card className="gap-0 py-0">
                  <CardContent className="flex items-center gap-3 p-5 text-sm text-muted-foreground">
                    <GitBranch className="h-4 w-4" />
                    <span>This workflow does not expose any registered nodes yet.</span>
                  </CardContent>
                </Card>
              ) : (
                workflow.nodes.map((node, index) => (
                  <WorkflowNodeRow key={node.id} node={node} index={index} />
                ))
              )}
            </div>

            <aside>
              <TriggersCard triggers={workflow.triggers} />
            </aside>
          </section>
        </TabsContent>

        <TabsContent value="runs">
          <WorkflowRunsTab workflowId={workflow.id} />
        </TabsContent>
      </Tabs>
    </PageFrame>
  )
}

function Stat({ count, singular, plural }: { count: number; singular: string; plural: string }) {
  return (
    <span>
      <span className="tabular-nums text-foreground">{count}</span>{" "}
      {count === 1 ? singular : plural}
    </span>
  )
}

function Separator() {
  return (
    <span aria-hidden className="text-muted-foreground/50">
      ·
    </span>
  )
}

function WorkflowInputCard({ fields }: { fields: Readonly<Record<string, unknown>> }) {
  const count = Object.keys(fields ?? {}).length
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardContent className="p-0">
        <div className="flex items-start gap-3 p-4">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Play className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="truncate text-sm font-medium text-foreground">Workflow input</h2>
              <Badge variant="secondary" className="rounded-md px-1.5 py-0 font-mono text-[10px]">
                start
              </Badge>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Data required before this workflow can run.
            </p>
          </div>
          <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground sm:inline">
            {fieldCountLabel(count)}
          </span>
        </div>
        <SchemaPanel label="Fields" fields={fields} emptyLabel="No input required" />
      </CardContent>
    </Card>
  )
}

function SchemaPanel({
  label,
  fields,
  emptyLabel,
}: {
  label: string
  fields: Readonly<Record<string, unknown>>
  emptyLabel: string
}) {
  const count = Object.keys(fields ?? {}).length
  return (
    <div className="border-t border-border/60 bg-muted/20 p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
        <span className="text-xs tabular-nums text-muted-foreground">{fieldCountLabel(count)}</span>
      </div>
      <SchemaShape fields={fields} emptyLabel={emptyLabel} />
    </div>
  )
}

function LatestRunBanner({ workflow }: { workflow: WorkflowDetail }) {
  const latest = workflow.latestRun
  if (!latest) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <History className="h-4 w-4" />
        <span>No runs yet for this workflow.</span>
      </div>
    )
  }
  return (
    <Link
      to={`/runs/${latest.id}`}
      className="group flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-background px-4 py-3 transition-colors hover:bg-muted/40"
    >
      <div className="flex min-w-0 items-center gap-3">
        <StatusBadge status={latest.status} />
        <div className="min-w-0">
          <p className="truncate text-sm text-foreground">
            Latest run <span className="font-mono text-xs text-muted-foreground">{latest.id}</span>
          </p>
          <p className="text-xs text-muted-foreground">{runTimeLabel(latest)}</p>
        </div>
      </div>
      <span className="shrink-0 text-xs text-muted-foreground group-hover:text-foreground">
        View run →
      </span>
    </Link>
  )
}

function TriggersCard({ triggers }: { triggers: readonly WorkflowTrigger[] }) {
  const triggerCount = triggers.length
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
        <CardTitle className="font-medium">Start Conditions</CardTitle>
        <span className="text-sm text-muted-foreground">{triggerCountLabel(triggerCount)}</span>
      </div>
      <CardContent className="p-5">
        {triggers.length === 0 ? (
          <div className="rounded-lg bg-muted/30 p-3">
            <p className="text-sm text-foreground">Manual or API start</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Runs begin when a person, app, or API invokes this workflow.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border/60">
            {triggers.map((trigger, index) => (
              <TriggerRow key={`${trigger.type}:${index}`} trigger={trigger} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function fieldCountLabel(count: number) {
  return `${count} input ${count === 1 ? "field" : "fields"}`
}

function triggerCountLabel(count: number) {
  return `${count} ${count === 1 ? "trigger" : "triggers"}`
}

function TriggerRow({ trigger }: { trigger: WorkflowTrigger }) {
  const isSchedule = trigger.type === "schedule"
  return (
    <li className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted/60 text-muted-foreground">
        {isSchedule ? (
          <CalendarClock className="h-3.5 w-3.5" />
        ) : (
          <Webhook className="h-3.5 w-3.5" />
        )}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">
          {isSchedule ? "Schedule" : trigger.type}
        </p>
        {isSchedule ? (
          <p className="truncate font-mono text-xs text-muted-foreground">{trigger.scheduleId}</p>
        ) : null}
      </div>
    </li>
  )
}

function WorkflowRunsTab({ workflowId }: { workflowId: string }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const statusParam = searchParams.get("status")
  const selectedStatus: WorkflowRunStatusFilter = isWorkflowRunStatus(statusParam)
    ? statusParam
    : "all"

  const updateRunParams = (next: { status?: WorkflowRunStatusFilter }) => {
    const params = new URLSearchParams(searchParams)
    if (next.status !== undefined) {
      if (next.status === "all") params.delete("status")
      else params.set("status", next.status)
      params.delete("page")
    }
    setSearchParams(params)
  }

  const query = {
    workflowId,
    limit: String(RUN_HISTORY_PAGE_SIZE),
    order: "desc" as const,
    ...(selectedStatus !== "all" ? { status: selectedStatus } : {}),
  }
  const runsQuery = useInfiniteQuery({
    ...listWorkflowRunsInfiniteOptions({ query }),
    initialPageParam: { query },
    getNextPageParam: (lastPage, _pages, lastPageParam) => {
      if (!lastPage.hasMore) return undefined

      const currentOffset =
        typeof lastPageParam === "object" && lastPageParam.query?.offset
          ? Number.parseInt(String(lastPageParam.query.offset), 10)
          : 0
      const nextOffset = Number.isFinite(currentOffset)
        ? currentOffset + RUN_HISTORY_PAGE_SIZE
        : RUN_HISTORY_PAGE_SIZE

      return {
        query: {
          ...query,
          offset: String(nextOffset),
        },
      }
    },
    refetchInterval:
      selectedStatus === "all" || selectedStatus === "queued" || selectedStatus === "running"
        ? 5000
        : false,
  })

  const runs = useMemo(
    () => runsQuery.data?.pages.flatMap((page) => page.runs) ?? [],
    [runsQuery.data]
  )
  const total = runsQuery.data?.pages[0]?.total ?? 0
  const filtered = selectedStatus !== "all"
  const selectedStatusLabel = selectedStatus === "all" ? "runs" : statusLabels[selectedStatus]
  const loadMoreRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const element = loadMoreRef.current
    if (!element || !runsQuery.hasNextPage) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && !runsQuery.isFetchingNextPage) {
          void runsQuery.fetchNextPage()
        }
      },
      { rootMargin: "240px" }
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [runsQuery.fetchNextPage, runsQuery.hasNextPage, runsQuery.isFetchingNextPage])

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex flex-col gap-3 border-b border-border px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-medium text-foreground">Recent Runs</h3>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            <span className="tabular-nums text-foreground">{total}</span>{" "}
            {filtered ? selectedStatusLabel.toLowerCase() : "recent"} run
            {total === 1 ? "" : "s"}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Select
            value={selectedStatus}
            onValueChange={(value) => {
              updateRunParams({
                status: isWorkflowRunStatus(value) ? value : "all",
              })
            }}
          >
            <SelectTrigger className="h-8 w-40 bg-background text-sm">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {allWorkflowRunStatuses.map((status) => (
                <SelectItem key={status} value={status}>
                  {statusLabels[status]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {filtered ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => updateRunParams({ status: "all" })}
            >
              Clear
            </Button>
          ) : null}
        </div>
      </div>

      {runsQuery.isLoading ? (
        <div className="px-5 py-8">
          <LoadingInline label="Loading run history..." />
        </div>
      ) : runsQuery.isError ? (
        <WorkflowRunsEmpty
          title="Run history unavailable"
          description="Could not load runs for this workflow."
        />
      ) : runs.length === 0 ? (
        <WorkflowRunsEmpty
          title={filtered ? "No matching runs" : "No runs yet"}
          description={
            filtered
              ? "Try another status to broaden the run history."
              : "Runs will appear here after this workflow executes."
          }
        />
      ) : (
        <>
          <RunHistoryTable runs={runs} variant="plain" />
          <WorkflowRunsInfiniteLoader
            loaderRef={loadMoreRef}
            loaded={runs.length}
            total={total}
            hasMore={runsQuery.hasNextPage}
            loading={runsQuery.isFetchingNextPage}
          />
        </>
      )}
    </section>
  )
}

function WorkflowRunsInfiniteLoader({
  loaderRef,
  loaded,
  total,
  hasMore,
  loading,
}: {
  loaderRef: Ref<HTMLDivElement>
  loaded: number
  total: number
  hasMore: boolean
  loading: boolean
}) {
  return (
    <div ref={loaderRef} className="border-t border-border px-5 py-4">
      <p className="text-sm text-muted-foreground">
        Showing <span className="font-medium text-foreground">{loaded}</span> of{" "}
        <span className="font-medium text-foreground">{total}</span>
      </p>
      {hasMore || loading ? (
        <div className="mt-3">
          <LoadingInline label={loading ? "Loading more runs..." : "Scroll to load more runs..."} />
        </div>
      ) : null}
    </div>
  )
}

function WorkflowRunsEmpty({ title, description }: { title: string; description: string }) {
  return (
    <div className="px-5 py-10">
      <div className="mx-auto flex max-w-sm flex-col items-center text-center">
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <History className="h-5 w-5" />
        </span>
        <p className="mt-3 text-sm font-medium text-foreground">{title}</p>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}
