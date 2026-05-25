import { Badge, Card, CardContent } from "@pario/ui/components"
import { Workflow, Zap } from "lucide-react"
import { formatNodeDuration, formatRelativeTime, type WorkflowRunNode } from "../utils/workflows"
import { RunIOShape } from "./RunIOShape"
import { NodeStatusBadge } from "./StatusBadge"

export function RunNodeRow({ node }: { node: WorkflowRunNode }) {
  const isStep = node.nodeType === "step"
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardContent className="p-0">
        <div className="flex items-start gap-3 p-4">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted font-mono text-sm font-medium tabular-nums text-muted-foreground">
            {node.nodeIndex + 1}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <h3 className="truncate text-sm font-medium text-foreground">{node.nodeKey}</h3>
              <Badge
                variant="secondary"
                className="shrink-0 gap-1 rounded-md px-1.5 py-0 text-[10px]"
              >
                {isStep ? <Workflow className="h-3 w-3" /> : <Zap className="h-3 w-3" />}
                {isStep ? "step" : "action"}
              </Badge>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>Started {formatRelativeTime(node.startedAt)}</span>
              <span>{formatNodeDuration(node)}</span>
              {node.finishedAt ? <span>Finished {formatRelativeTime(node.finishedAt)}</span> : null}
            </div>
          </div>
          <NodeStatusBadge status={node.status} />
        </div>

        <div className="grid gap-px border-t border-border/60 bg-border/40 lg:grid-cols-2">
          <JsonPanel label="Input" value={node.input} />
          <JsonPanel
            label={node.error ? "Error" : "Output"}
            value={node.output ?? node.error ?? null}
          />
        </div>
      </CardContent>
    </Card>
  )
}

function JsonPanel({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="min-w-0 bg-card p-4">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <RunIOShape value={value} />
    </div>
  )
}
