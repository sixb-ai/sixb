import { Link } from "react-router-dom"
import {
  formatDate,
  formatRunDuration,
  runTimeLabel,
  type WorkflowRunSummary,
} from "../../utils/workflows"
import { useRunHistoryNavigation } from "./runHistoryNavigation"
import { StatusBadge } from "./StatusBadge"

export function RunListItem({
  run,
  expanded = false,
}: {
  run: WorkflowRunSummary
  expanded?: boolean
}) {
  const { workflowPath, onContainerClick, onContainerKeyDown } = useRunHistoryNavigation(run)

  return (
    <article
      role="link"
      tabIndex={0}
      aria-label={`Open run ${run.id}`}
      onClick={onContainerClick}
      onKeyDown={onContainerKeyDown}
      className="block cursor-pointer rounded-xl px-3 py-3 transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="truncate font-mono text-xs text-muted-foreground">{run.id}</p>
          <Link
            to={workflowPath}
            className="block truncate text-sm font-medium text-foreground underline-offset-4 hover:underline"
          >
            {run.workflowId}
          </Link>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{runTimeLabel(run)}</span>
            <span>{formatRunDuration(run)}</span>
          </div>
          {expanded ? (
            <p className="text-xs text-muted-foreground">
              {formatDate(run.queuedAt ?? run.startedAt)}
            </p>
          ) : null}
          {run.error ? (
            <p className="break-words text-xs text-destructive">{run.error.message}</p>
          ) : null}
        </div>
        <StatusBadge status={run.status} />
      </div>
    </article>
  )
}
