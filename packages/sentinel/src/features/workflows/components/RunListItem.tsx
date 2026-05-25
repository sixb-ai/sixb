import { Link } from "react-router-dom"
import {
  formatDate,
  formatRunDuration,
  runTimeLabel,
  type WorkflowRunSummary,
} from "../utils/workflows"
import { StatusBadge } from "./StatusBadge"

export function RunListItem({
  run,
  expanded = false,
}: {
  run: WorkflowRunSummary
  expanded?: boolean
}) {
  return (
    <Link
      to={`/runs/${run.id}`}
      className="block rounded-xl px-3 py-3 transition-colors hover:bg-muted/40"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="truncate font-mono text-xs text-muted-foreground">{run.id}</p>
          <p className="truncate text-sm font-medium text-foreground">{run.workflowId}</p>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{runTimeLabel(run)}</span>
            <span>{formatRunDuration(run)}</span>
          </div>
          {expanded ? (
            <p className="text-xs text-muted-foreground">
              {formatDate(run.queuedAt ?? run.startedAt)}
            </p>
          ) : null}
          {run.error ? <p className="break-words text-xs text-destructive">{run.error}</p> : null}
        </div>
        <StatusBadge status={run.status} />
      </div>
    </Link>
  )
}
