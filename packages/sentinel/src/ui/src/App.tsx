import type {
  GetWorkflowResponse,
  GetWorkflowRunResponse,
  ListWorkflowRunsResponse,
  ListWorkflowsResponse,
} from "@pario/client"
import {
  getProjectInfoOptions,
  getWorkflowOptions,
  getWorkflowRunOptions,
  listWorkflowRunsOptions,
  listWorkflowsOptions,
} from "@pario/client/hooks"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
} from "@pario/ui/components"
import { cn } from "@pario/ui/lib/utils"
import { useQuery } from "@tanstack/react-query"
import { AlertCircle, ArrowRight, GitBranch, History, Loader2, Workflow } from "lucide-react"
import type { ReactNode } from "react"
import {
  Link,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom"
import { AppShell, Sidebar, type ViewMode } from "./components/layout"

type WorkflowSummary = ListWorkflowsResponse[number]
type WorkflowDetail = GetWorkflowResponse
type WorkflowNode = WorkflowDetail["nodes"][number]
type WorkflowRunSummary = ListWorkflowRunsResponse["runs"][number]
type WorkflowRunDetail = GetWorkflowRunResponse["run"]
type WorkflowRunNode = GetWorkflowRunResponse["nodes"][number]
type WorkflowRunStatus = WorkflowRunSummary["status"]
type WorkflowNodeStatus = WorkflowRunNode["status"]

const statusClasses: Record<WorkflowRunStatus, string> = {
  queued:
    "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-300",
  running:
    "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300",
  succeeded:
    "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300",
  failed:
    "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300",
  cancelled:
    "border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300",
}

const nodeStatusClasses: Record<WorkflowNodeStatus, string> = {
  running: statusClasses.running,
  succeeded: statusClasses.succeeded,
  failed: statusClasses.failed,
  cancelled: statusClasses.cancelled,
}

function formatDate(value?: string): string {
  if (!value) return "Not recorded"

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date)
}

function AppLayout() {
  const navigate = useNavigate()
  const location = useLocation()

  const projectQuery = useQuery({
    ...getProjectInfoOptions(),
    retry: false,
  })
  const workflowsQuery = useQuery({
    ...listWorkflowsOptions(),
    enabled: projectQuery.isSuccess,
  })
  const runsQuery = useQuery({
    ...listWorkflowRunsOptions({ query: { limit: "1", order: "desc" } }),
    enabled: projectQuery.isSuccess,
  })

  const selectedProject = projectQuery.data
    ? { name: projectQuery.data.id, type: projectQuery.data.type }
    : null
  const viewMode = getViewModeFromPath(location.pathname)
  const sidebar = (
    <Sidebar
      selectedProject={selectedProject}
      connected={projectQuery.isSuccess}
      viewMode={viewMode}
      onViewChange={(mode) => navigate(mode === "workflows" ? "/" : "/runs")}
      workflowCount={workflowsQuery.data?.length}
      runCount={runsQuery.data?.total}
    />
  )

  return (
    <AppShell sidebar={sidebar} currentProjectName={selectedProject?.name ?? null}>
      <Outlet />
    </AppShell>
  )
}

function getViewModeFromPath(pathname: string): ViewMode {
  return pathname === "/runs" || pathname.startsWith("/runs/") ? "runs" : "workflows"
}

function WorkflowsPage() {
  const workflowsQuery = useQuery(listWorkflowsOptions())
  const runsQuery = useQuery(listWorkflowRunsOptions({ query: { limit: "8", order: "desc" } }))
  const workflows = workflowsQuery.data ?? []
  const runs = runsQuery.data?.runs ?? []

  if (workflowsQuery.isLoading) {
    return <LoadingPage label="Loading workflows..." />
  }

  if (workflowsQuery.isError) {
    return (
      <ErrorPage title="Workflows unavailable" description="Could not load workflow metadata." />
    )
  }

  return (
    <PageFrame
      eyebrow="Sentinel"
      title="Workflow Visibility"
      description="Inspect registered workflows and jump into recent run state."
    >
      <div className="grid gap-3 md:grid-cols-3">
        <MetricCard label="Workflows" value={workflows.length} />
        <MetricCard label="Recent runs" value={runsQuery.data?.total ?? 0} />
        <MetricCard
          label="Active recent"
          value={runs.filter((run) => run.status === "queued" || run.status === "running").length}
        />
      </div>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <Card>
          <CardHeader>
            <CardTitle>Registered Workflows</CardTitle>
          </CardHeader>
          <CardContent>
            {workflows.length === 0 ? (
              <EmptyState
                icon={<Workflow className="size-12 stroke-1" />}
                title="No workflows registered"
                description="Create a workflow definition to see it appear in Sentinel."
              />
            ) : (
              <div className="grid gap-3">
                {workflows.map((workflow) => (
                  <WorkflowCard key={workflow.id} workflow={workflow} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent Runs</CardTitle>
          </CardHeader>
          <CardContent>
            {runsQuery.isLoading ? (
              <LoadingInline label="Loading runs..." />
            ) : runs.length === 0 ? (
              <EmptyState
                icon={<History className="size-12 stroke-1" />}
                title="No run history"
                description="Requested workflow runs will appear here."
              />
            ) : (
              <div className="space-y-3">
                {runs.map((run) => (
                  <RunListItem key={run.id} run={run} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </section>
    </PageFrame>
  )
}

function WorkflowDetailPage() {
  const { workflowId = "" } = useParams()
  const workflowQuery = useQuery({
    ...getWorkflowOptions({ path: { workflowId } }),
    enabled: workflowId.length > 0,
  })
  const runsQuery = useQuery({
    ...listWorkflowRunsOptions({ query: { workflowId, limit: "8", order: "desc" } }),
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
  const runs = runsQuery.data?.runs ?? []

  return (
    <PageFrame
      eyebrow="Workflow"
      title={workflow.id}
      description={`${workflow.nodes.length} node${workflow.nodes.length === 1 ? "" : "s"} · ${workflow.triggers.length} trigger${workflow.triggers.length === 1 ? "" : "s"}`}
      backTo="/"
      backLabel="Workflows"
    >
      <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Nodes</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {workflow.nodes.length === 0 ? (
                <EmptyState
                  icon={<GitBranch className="size-12 stroke-1" />}
                  title="No nodes"
                  description="This workflow does not expose any registered nodes yet."
                />
              ) : (
                workflow.nodes.map((node, index) => (
                  <WorkflowNodeRow key={node.id} node={node} index={index} />
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Input Shape</CardTitle>
            </CardHeader>
            <CardContent>
              <JsonPreview value={workflow.input} />
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Latest Runs</CardTitle>
          </CardHeader>
          <CardContent>
            {runsQuery.isLoading ? (
              <LoadingInline label="Loading runs..." />
            ) : runs.length === 0 ? (
              <EmptyState
                icon={<History className="size-12 stroke-1" />}
                title="No runs"
                description="Run history for this workflow will appear here."
              />
            ) : (
              <div className="space-y-3">
                {runs.map((run) => (
                  <RunListItem key={run.id} run={run} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </section>
    </PageFrame>
  )
}

function RunsPage() {
  const runsQuery = useQuery(listWorkflowRunsOptions({ query: { limit: "25", order: "desc" } }))
  const runs = runsQuery.data?.runs ?? []

  if (runsQuery.isLoading) {
    return <LoadingPage label="Loading run history..." />
  }

  if (runsQuery.isError) {
    return <ErrorPage title="Runs unavailable" description="Could not load workflow run history." />
  }

  return (
    <PageFrame
      eyebrow="Runs"
      title="Workflow Runs"
      description="Recent workflow requests across all registered definitions."
    >
      <Card>
        <CardHeader>
          <CardTitle>{runsQuery.data?.total ?? 0} Recorded Runs</CardTitle>
        </CardHeader>
        <CardContent>
          {runs.length === 0 ? (
            <EmptyState
              icon={<History className="size-12 stroke-1" />}
              title="No run history"
              description="Queued, running, and finished workflow runs will appear here."
            />
          ) : (
            <div className="grid gap-3">
              {runs.map((run) => (
                <RunListItem key={run.id} run={run} expanded />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </PageFrame>
  )
}

function RunDetailPage() {
  const { runId = "" } = useParams()
  const runQuery = useQuery({
    ...getWorkflowRunOptions({ path: { runId } }),
    enabled: runId.length > 0,
  })

  if (!runId) {
    return <Navigate to="/runs" replace />
  }

  if (runQuery.isLoading) {
    return <LoadingPage label="Loading workflow run..." />
  }

  if (runQuery.isError || !runQuery.data) {
    return <ErrorPage title="Run unavailable" description="Could not load workflow run detail." />
  }

  const { run, nodes } = runQuery.data

  return (
    <PageFrame
      eyebrow="Run"
      title={run.id}
      description={run.workflowId}
      backTo="/runs"
      backLabel="Runs"
    >
      <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <Card>
          <CardHeader>
            <CardTitle>Node Results</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {nodes.length === 0 ? (
              <EmptyState
                icon={<GitBranch className="size-12 stroke-1" />}
                title="No node results"
                description="Node-level results will appear once the worker starts the run."
              />
            ) : (
              nodes.map((node) => (
                <RunNodeRow key={`${node.workflowRunId}:${node.nodeIndex}`} node={node} />
              ))
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <RunSummaryCard run={run} />
          <Card>
            <CardHeader>
              <CardTitle>Run Input</CardTitle>
            </CardHeader>
            <CardContent>
              <JsonPreview value={run.input} />
            </CardContent>
          </Card>
        </div>
      </section>
    </PageFrame>
  )
}

function WorkflowCard({ workflow }: { workflow: WorkflowSummary }) {
  return (
    <Link
      to={`/workflows/${workflow.id}`}
      className="group rounded-lg border border-border bg-card p-4 transition-colors hover:border-foreground/30"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <GitBranch className="h-4 w-4 text-muted-foreground" />
            <h3 className="truncate font-medium text-foreground">{workflow.id}</h3>
          </div>
          <p className="text-sm text-muted-foreground">
            {workflow.nodes.length} node{workflow.nodes.length === 1 ? "" : "s"} ·{" "}
            {workflow.triggers.length} trigger
            {workflow.triggers.length === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {workflow.latestRun ? <StatusBadge status={workflow.latestRun.status} /> : null}
          <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
        </div>
      </div>
    </Link>
  )
}

function RunListItem({ run, expanded = false }: { run: WorkflowRunSummary; expanded?: boolean }) {
  return (
    <Link
      to={`/runs/${run.id}`}
      className="block rounded-lg border border-border bg-background p-3 transition-colors hover:border-foreground/30"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="truncate font-mono text-xs text-muted-foreground">{run.id}</p>
          <p className="truncate text-sm font-medium text-foreground">{run.workflowId}</p>
          {expanded ? (
            <p className="text-xs text-muted-foreground">Started {formatDate(run.startedAt)}</p>
          ) : null}
        </div>
        <StatusBadge status={run.status} />
      </div>
    </Link>
  )
}

function WorkflowNodeRow({ node, index }: { node: WorkflowNode; index: number }) {
  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {index + 1}. {node.type}
          </p>
          <h3 className="truncate font-medium text-foreground">{node.key}</h3>
        </div>
        <Badge variant="outline">{node.id}</Badge>
      </div>
      {node.type === "action" ? (
        <p className="mt-2 text-sm text-muted-foreground">Target: {node.targetObjectTypeId}</p>
      ) : null}
    </div>
  )
}

function RunNodeRow({ node }: { node: WorkflowRunNode }) {
  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {node.nodeIndex + 1}. {node.nodeType}
          </p>
          <h3 className="truncate font-medium text-foreground">{node.nodeKey}</h3>
        </div>
        <NodeStatusBadge status={node.status} />
      </div>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <JsonPreview label="Input" value={node.input} />
        <JsonPreview label="Output" value={node.output ?? node.error ?? null} />
      </div>
    </div>
  )
}

function RunSummaryCard({ run }: { run: WorkflowRunDetail }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <CardTitle>Summary</CardTitle>
          <StatusBadge status={run.status} />
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <KeyValue label="Workflow" value={run.workflowId} to={`/workflows/${run.workflowId}`} />
        <KeyValue label="Project" value={run.projectId} />
        <KeyValue label="Queued" value={formatDate(run.queuedAt)} />
        <KeyValue label="Started" value={formatDate(run.startedAt)} />
        <KeyValue label="Finished" value={formatDate(run.finishedAt)} />
        {run.error ? <KeyValue label="Error" value={run.error} /> : null}
      </CardContent>
    </Card>
  )
}

function PageFrame({
  eyebrow,
  title,
  description,
  backTo,
  backLabel,
  children,
}: {
  eyebrow: string
  title: string
  description: string
  backTo?: string
  backLabel?: string
  children: ReactNode
}) {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-3 sm:p-4 lg:p-6">
      {backTo && backLabel ? (
        <Button
          variant="ghost"
          size="sm"
          asChild
          className="-ml-2 self-start text-muted-foreground hover:text-foreground"
        >
          <Link to={backTo}>{backLabel}</Link>
        </Button>
      ) : null}
      <header className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {eyebrow}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          {title}
        </h1>
        <p className="max-w-3xl text-sm text-muted-foreground">{description}</p>
      </header>
      {children}
    </div>
  )
}

function MetricCard({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{value}</p>
      </CardContent>
    </Card>
  )
}

function StatusBadge({ status }: { status: WorkflowRunStatus }) {
  return (
    <Badge variant="outline" className={cn("capitalize", statusClasses[status])}>
      {status}
    </Badge>
  )
}

function NodeStatusBadge({ status }: { status: WorkflowNodeStatus }) {
  return (
    <Badge variant="outline" className={cn("capitalize", nodeStatusClasses[status])}>
      {status}
    </Badge>
  )
}

function KeyValue({ label, value, to }: { label: string; value: string; to?: string }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="break-words text-foreground">
        {to ? (
          <Link to={to} className="underline-offset-4 hover:underline">
            {value}
          </Link>
        ) : (
          value
        )}
      </p>
    </div>
  )
}

function JsonPreview({ label, value }: { label?: string; value: unknown }) {
  const rendered = JSON.stringify(value ?? null, null, 2)
  return (
    <div className="min-w-0 space-y-2">
      {label ? (
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      ) : null}
      <pre className="max-h-72 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground scrollbar-auto-hide">
        {rendered}
      </pre>
    </div>
  )
}

function LoadingPage({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center p-4">
      <LoadingInline label={label} />
    </div>
  )
}

function LoadingInline({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 text-muted-foreground">
      <Loader2 className="h-5 w-5 animate-spin" />
      <span className="text-sm">{label}</span>
    </div>
  )
}

function ErrorPage({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex h-full items-center justify-center p-4 sm:p-8">
      <Card className="mx-auto max-w-md p-6 text-center">
        <EmptyState
          icon={<AlertCircle className="size-12 stroke-1" />}
          title={title}
          description={description}
        />
        <Button
          variant="outline"
          size="sm"
          className="mx-auto mt-2"
          onClick={() => window.location.reload()}
        >
          Retry
        </Button>
      </Card>
    </div>
  )
}

export default function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<WorkflowsPage />} />
        <Route path="workflows/:workflowId" element={<WorkflowDetailPage />} />
        <Route path="runs" element={<RunsPage />} />
        <Route path="runs/:runId" element={<RunDetailPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
