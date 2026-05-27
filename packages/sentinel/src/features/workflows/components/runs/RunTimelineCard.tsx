import { Card, CardContent, CardHeader, CardTitle } from "@pario/ui/components"
import { cn } from "@pario/ui/lib/utils"
import {
  formatDate,
  formatNodeDuration,
  statusLabels,
  type WorkflowNodeStatus,
  type WorkflowRunDetail,
  type WorkflowRunNode,
  type WorkflowRunStatus,
} from "../../utils/workflows"

export function RunTimelineCard({
  run,
  nodes,
}: {
  run: WorkflowRunDetail
  nodes: readonly WorkflowRunNode[]
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Timeline</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {run.queuedAt ? (
            <TimelineItem
              title="Run queued"
              description={formatDate(run.queuedAt)}
              status="queued"
            />
          ) : null}
          {run.status !== "queued" ? (
            <TimelineItem
              title="Run started"
              description={formatDate(run.startedAt)}
              status="running"
            />
          ) : null}
          {nodes.map((node) => (
            <TimelineItem
              key={`${node.workflowRunId}:${node.nodeIndex}:timeline`}
              title={`${node.nodeIndex + 1}. ${node.nodeKey}`}
              description={`${statusLabels[node.status]} · ${formatNodeDuration(node)}`}
              status={node.status}
            />
          ))}
          {run.finishedAt ? (
            <TimelineItem
              title={run.status === "failed" ? "Run failed" : "Run finished"}
              description={formatDate(run.finishedAt)}
              status={run.status}
            />
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}

function TimelineItem({
  title,
  description,
  status,
}: {
  title: string
  description: string
  status: WorkflowRunStatus | WorkflowNodeStatus
}) {
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-3">
      <span
        className={cn(
          "mt-1 h-2.5 w-2.5 rounded-full ring-4 ring-background",
          timelineDotClass(status)
        )}
      />
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}

function timelineDotClass(status: WorkflowRunStatus | WorkflowNodeStatus): string {
  switch (status) {
    case "queued":
      return "bg-sky-500"
    case "running":
      return "bg-amber-500"
    case "succeeded":
      return "bg-emerald-500"
    case "failed":
      return "bg-red-500"
    case "cancelled":
      return "bg-zinc-500"
  }
}
