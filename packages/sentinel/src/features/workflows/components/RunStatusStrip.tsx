import { allWorkflowRunStatuses, type WorkflowRunStatus } from "../utils/workflows"
import { StatusBadge } from "./StatusBadge"

export function RunStatusStrip({ counts }: { counts: Record<WorkflowRunStatus, number> }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
      {allWorkflowRunStatuses.map((status) => (
        <div
          key={status}
          className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2"
        >
          <StatusBadge status={status} />
          <span className="font-mono text-sm tabular-nums text-muted-foreground">
            {counts[status]}
          </span>
        </div>
      ))}
    </div>
  )
}
