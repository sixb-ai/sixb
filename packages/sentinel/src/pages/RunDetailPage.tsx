import { getWorkflowOptions, getWorkflowRunOptions } from "@pario/client/hooks"
import { Badge, Button, Card, CardContent, CardTitle, EmptyState } from "@pario/ui/components"
import { useQuery } from "@tanstack/react-query"
import { Check, Copy, GitBranch, Play } from "lucide-react"
import type { ReactNode } from "react"
import { useEffect, useState } from "react"
import { Link, Navigate, useParams } from "react-router-dom"
import { ErrorPage, LoadingPage, PageFrame } from "../components/common"
import { RunNodeRow } from "../features/workflows/components/nodes/RunNodeRow"
import { RunIOShape } from "../features/workflows/components/runs/RunIOShape"
import { RunProgress } from "../features/workflows/components/runs/RunProgress"
import { StatusBadge } from "../features/workflows/components/runs/StatusBadge"
import {
  formatDate,
  formatRunDuration,
  formatRunStartedDate,
  isActiveRunStatus,
  runTimeLabel,
  type WorkflowRunDetail,
} from "../features/workflows/utils/workflows"

export function RunDetailPage() {
  const { runId = "" } = useParams()
  const runQuery = useQuery({
    ...getWorkflowRunOptions({ path: { runId } }),
    enabled: runId.length > 0,
    refetchInterval: (query) => {
      const status = query.state.data?.run.status
      return status && isActiveRunStatus(status) ? 5000 : false
    },
  })
  const workflowId = runQuery.data?.run.workflowId
  const workflowQuery = useQuery({
    ...getWorkflowOptions({ path: { workflowId: workflowId ?? "" } }),
    enabled: Boolean(workflowId),
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
  const totalSteps = workflowQuery.data?.nodes.length ?? 0

  return (
    <PageFrame
      title={<RunDetailTitle run={run} />}
      description={<RunDetailMeta run={run} nodeCount={nodes.length} />}
      backTo="/runs"
      backLabel="Run history"
      contentClassName="mx-auto max-w-5xl gap-3"
    >
      <section className="space-y-5">
        <RunHeaderStats run={run} />

        <section className="space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-sm font-medium text-foreground">Timeline</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Run input followed by {nodes.length} recorded node
                {nodes.length === 1 ? "" : "s"}.
              </p>
            </div>
            <RunProgress status={run.status} nodes={nodes} totalSteps={totalSteps} />
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
              {nodes.map((node, index) => (
                <RunNodeRow
                  key={`${node.workflowRunId}:${node.nodeIndex}`}
                  node={node}
                  // Collapse finished steps so the run reads as a scannable flow;
                  // keep the last step (final output) and any non-succeeded step open.
                  defaultOpen={node.status !== "succeeded" || index === nodes.length - 1}
                />
              ))}
            </div>
          )}
        </section>
      </section>
    </PageFrame>
  )
}

function RunDetailMeta({ run, nodeCount }: { run: WorkflowRunDetail; nodeCount: number }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      <span>
        <span className="tabular-nums text-foreground">{nodeCount}</span> recorded node
        {nodeCount === 1 ? "" : "s"}
      </span>
      <MetaSeparator />
      <span>{runTimeLabel(run)}</span>
    </span>
  )
}

function MetaSeparator() {
  return (
    <span aria-hidden className="text-muted-foreground/50">
      ·
    </span>
  )
}

function RunDetailTitle({ run }: { run: WorkflowRunDetail }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
      <Link
        to={`/workflows/${run.workflowId}`}
        className="min-w-0 truncate underline-offset-4 hover:underline"
      >
        {run.workflowId}
      </Link>
      <CopyRunIdButton runId={run.id} />
    </span>
  )
}

function CopyRunIdButton({ runId }: { runId: string }) {
  const [copied, setCopied] = useState(false)
  const label = copied ? "Copied" : shortRunId(runId)

  useEffect(() => {
    if (!copied) return

    const timeout = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(timeout)
  }, [copied])

  const onCopy = async () => {
    const copiedToClipboard = await copyText(runId)
    if (copiedToClipboard) {
      setCopied(true)
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      onClick={onCopy}
      title={runId}
      aria-label={`Copy run id ${runId}`}
      className="h-7 max-w-full rounded-md border-border bg-card px-2 text-xs font-medium text-muted-foreground shadow-none hover:text-foreground"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-emerald-600" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
      <span className="min-w-0 truncate font-mono">{label}</span>
    </Button>
  )
}

function shortRunId(runId: string): string {
  if (runId.length <= 24) return runId
  return `${runId.slice(0, 12)}...${runId.slice(-8)}`
}

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    return fallbackCopyText(value)
  }
}

function fallbackCopyText(value: string): boolean {
  const textarea = document.createElement("textarea")
  textarea.value = value
  textarea.setAttribute("readonly", "")
  textarea.style.position = "fixed"
  textarea.style.opacity = "0"
  document.body.append(textarea)
  textarea.select()

  try {
    return document.execCommand("copy")
  } finally {
    textarea.remove()
  }
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
