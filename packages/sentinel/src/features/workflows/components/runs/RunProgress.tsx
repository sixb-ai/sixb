import { cn } from "@pario/ui/lib/utils"
import type { WorkflowRunNode, WorkflowRunStatus } from "../../utils/workflows"

const barColorByStatus: Record<WorkflowRunStatus, string> = {
  queued: "bg-sky-500",
  running: "bg-amber-500",
  waiting: "bg-amber-500",
  succeeded: "bg-emerald-500",
  failed: "bg-red-500",
  cancelled: "bg-zinc-400",
}

interface RunProgressProps {
  status: WorkflowRunStatus
  nodes: readonly WorkflowRunNode[]
  /** Total nodes defined by the workflow — the "of Y". */
  totalSteps: number
  className?: string
}

/**
 * Compact "Step X of Y" indicator with a progress bar. Reflects how far a run has
 * advanced through its defined steps — most useful while a run is streaming live.
 */
export function RunProgress({ status, nodes, totalSteps, className }: RunProgressProps) {
  if (totalSteps <= 0) return null

  const succeeded = nodes.filter((node) => node.status === "succeeded").length
  // The node that pins "where we are": the one running, else the one that ended the run.
  const marker =
    nodes.find((node) => node.status === "running") ??
    nodes.find((node) => node.status === "failed") ??
    nodes.find((node) => node.status === "cancelled")
  const current = clamp(marker ? marker.nodeIndex + 1 : succeeded, 0, totalSteps)
  const percent = Math.round((current / totalSteps) * 100)

  return (
    <div className={cn("min-w-0 sm:w-56", className)}>
      <span className="block truncate text-xs font-medium tabular-nums text-foreground">
        {progressLabel(status, current, succeeded, totalSteps)}
      </span>
      <div
        className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={current}
        aria-valuemin={0}
        aria-valuemax={totalSteps}
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500 ease-out",
            barColorByStatus[status]
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}

function progressLabel(
  status: WorkflowRunStatus,
  current: number,
  succeeded: number,
  total: number
): string {
  switch (status) {
    case "queued":
      return `0 of ${total} steps`
    case "running":
      return `Step ${current} of ${total}`
    case "failed":
      return `Failed at step ${current} of ${total}`
    case "cancelled":
      return `Cancelled at step ${current} of ${total}`
    default:
      return `${succeeded} of ${total} steps`
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
