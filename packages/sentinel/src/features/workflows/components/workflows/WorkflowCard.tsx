import { Card } from "@sixb/ui/components"
import { ArrowRight, GitBranch } from "lucide-react"
import { Link } from "react-router-dom"
import { runTimeLabel, type WorkflowSummary } from "../../utils/workflows"
import { StatusBadge } from "../runs/StatusBadge"

export function WorkflowCard({ workflow }: { workflow: WorkflowSummary }) {
  const inputFieldCount = Object.keys(workflow.input ?? {}).length

  return (
    <Link
      to={`/workflows/${workflow.id}`}
      className="group block rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <Card className="gap-0 overflow-hidden py-0 transition-colors group-hover:border-foreground/20 group-hover:bg-muted/20">
        <div className="flex min-w-0 items-start justify-between gap-4 p-5">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <GitBranch className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h3 className="truncate font-medium text-foreground">{workflow.id}</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {workflow.nodes.length} node{workflow.nodes.length === 1 ? "" : "s"} ·{" "}
                {workflow.triggers.length} trigger
                {workflow.triggers.length === 1 ? "" : "s"} · {inputFieldCount} input{" "}
                {inputFieldCount === 1 ? "field" : "fields"}
              </p>
            </div>
          </div>
          <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-[opacity,transform] group-hover:translate-x-0.5 sm:opacity-0 sm:group-hover:opacity-100" />
        </div>

        <div className="flex min-h-14 items-center justify-between gap-4 border-t border-border/60 bg-muted/20 px-5 py-3">
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
