import { getWorkflowRunOptions } from "@pario/client/hooks"
import { Badge, Card, CardContent, CardTitle, EmptyState } from "@pario/ui/components"
import { useQuery } from "@tanstack/react-query"
import { GitBranch, Play } from "lucide-react"
import type { ReactNode } from "react"
import { Navigate, useParams } from "react-router-dom"
import { ErrorPage, LoadingPage, PageFrame } from "../components/common"
import { RunIOShape } from "../features/workflows/components/RunIOShape"
import { RunNodeRow } from "../features/workflows/components/RunNodeRow"
import { StatusBadge } from "../features/workflows/components/StatusBadge"
import {
  formatDate,
  formatRunDuration,
  formatRunStartedDate,
  type WorkflowRunDetail,
} from "../features/workflows/utils/workflows"

export function RunDetailPage() {
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
      contentClassName="mx-auto max-w-5xl"
    >
      <section className="space-y-5">
        <RunHeaderStats run={run} />

        <section className="space-y-3">
          <div>
            <h2 className="text-sm font-medium text-foreground">Timeline</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Run input followed by {nodes.length} recorded node
              {nodes.length === 1 ? "" : "s"}.
            </p>
          </div>

          <RunInputCard value={run.input} />

          {nodes.length === 0 ? (
            <Card className="p-8 text-center">
              <EmptyState
                icon={<GitBranch className="size-12 stroke-1" />}
                title="No node results"
                description="Node-level results will appear once the worker starts the run."
              />
            </Card>
          ) : (
            <div className="space-y-3">
              {nodes.map((node) => (
                <RunNodeRow key={`${node.workflowRunId}:${node.nodeIndex}`} node={node} />
              ))}
            </div>
          )}
        </section>
      </section>
    </PageFrame>
  )
}

function RunHeaderStats({ run }: { run: WorkflowRunDetail }) {
  return (
    <Card className="grid gap-px overflow-hidden bg-border/60 py-0 sm:grid-cols-2 lg:grid-cols-5">
      <RunStat label="Status">
        <StatusBadge status={run.status} />
      </RunStat>
      <RunStat label="Duration">{formatRunDuration(run)}</RunStat>
      <RunStat label="Started">{formatRunStartedDate(run)}</RunStat>
      <RunStat label="Finished">{formatDate(run.finishedAt)}</RunStat>
      <RunStat label="Queued">{formatDate(run.queuedAt)}</RunStat>
    </Card>
  )
}

function RunStat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 bg-card p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <div className="mt-2 min-w-0 text-sm font-medium text-foreground">{children}</div>
    </div>
  )
}

function RunInputCard({ value }: { value: unknown }) {
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardContent className="p-0">
        <div className="flex items-start gap-3 p-4">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Play className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <CardTitle className="truncate text-sm font-medium">Run input</CardTitle>
              <Badge variant="secondary" className="rounded-md px-1.5 py-0 font-mono text-[10px]">
                start
              </Badge>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">Requested input</p>
          </div>
        </div>
        <div className="border-t border-border/60 bg-muted/20 p-4">
          <RunIOShape value={value} />
        </div>
      </CardContent>
    </Card>
  )
}
