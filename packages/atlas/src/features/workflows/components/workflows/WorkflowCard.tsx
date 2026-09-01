import { Card } from "@sixb/ui/components"
import { GitBranch } from "lucide-react"
import { Link } from "react-router-dom"
import { humanizeIdentifier } from "../../../../lib/labels"
import { runTimeLabel, type WorkflowSummary } from "../../utils/workflows"
import { StatusBadge } from "../runs/StatusBadge"

export function WorkflowCard({ workflow }: { workflow: WorkflowSummary }) {
  const inputCount = Object.keys(workflow.input ?? {}).length
  return (
    <Link
      to={`/workflows/${workflow.id}`}
      className="group block rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <Card className="h-full gap-0 overflow-hidden p-0 transition-colors group-hover:border-[var(--atlas-border-hover)] group-hover:bg-[var(--atlas-surface-hover)]">
        <div className="flex min-w-0 items-center gap-3 p-4">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[var(--atlas-panel-subtle)] text-muted-foreground">
            <GitBranch className="size-4" />
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-medium text-foreground">
              {humanizeIdentifier(workflow.id)}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {workflow.nodes.length} node{workflow.nodes.length === 1 ? "" : "s"} ·{" "}
              {workflow.triggers.length} trigger{workflow.triggers.length === 1 ? "" : "s"} ·{" "}
              {inputCount} input {inputCount === 1 ? "field" : "fields"}
            </p>
          </div>
        </div>

        <div className="flex min-h-14 items-center justify-between gap-3 border-t border-border px-4 py-3">
          {workflow.latestRun ? (
            <>
              <p className="min-w-0 truncate text-sm text-muted-foreground">
                Latest run {runTimeLabel(workflow.latestRun)}
              </p>
              <StatusBadge status={workflow.latestRun.status} />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No runs recorded</p>
          )}
        </div>
      </Card>
    </Link>
  )
}
