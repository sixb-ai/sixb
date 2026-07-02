import { client } from "@sixb/client"
import { Badge, Card, CardContent } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { ChevronRight, UserCheck, Workflow, Zap } from "lucide-react"
import { useState } from "react"
import { StructuredValue } from "../../../../components/StructuredValue"
import { workflowNodeFileContentUrl } from "../../../../lib/files"
import { formatNodeDuration, formatRelativeTime, type WorkflowRunNode } from "../../utils/workflows"
import { NodeStatusBadge } from "../runs/StatusBadge"
import { WorkflowInterventionPanel } from "./WorkflowInterventionPanel"

export function RunNodeRow({
  node,
  defaultOpen = true,
}: {
  node: WorkflowRunNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const outputLabel = node.error
    ? "Error"
    : node.nodeType === "intervention"
      ? "Response"
      : "Output"

  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardContent className="p-0">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex w-full items-start gap-3 p-4 text-left transition-colors hover:bg-muted/40"
        >
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
                <NodeTypeIcon type={node.nodeType} />
                {node.nodeType}
              </Badge>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>Started {formatRelativeTime(node.startedAt)}</span>
              <span>{formatNodeDuration(node)}</span>
              {node.finishedAt ? <span>Finished {formatRelativeTime(node.finishedAt)}</span> : null}
            </div>
          </div>
          <NodeStatusBadge status={node.status} />
          <ChevronRight
            className={cn(
              "mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90"
            )}
          />
        </button>

        {open ? (
          <>
            {node.nodeType === "intervention" && node.status === "waiting" ? (
              <WorkflowInterventionPanel node={node} />
            ) : null}

            <div className="grid gap-px border-t border-border/60 bg-border/40 lg:grid-cols-2">
              <JsonPanel label="Input" value={node.input} node={node} root="input" />
              <JsonPanel
                label={outputLabel}
                value={node.output ?? node.error ?? null}
                node={node}
                root="output"
              />
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  )
}

function NodeTypeIcon({ type }: { type: WorkflowRunNode["nodeType"] }) {
  if (type === "step") return <Workflow className="h-3 w-3" />
  if (type === "intervention") return <UserCheck className="h-3 w-3" />
  return <Zap className="h-3 w-3" />
}

function JsonPanel({
  label,
  value,
  node,
  root,
}: {
  label: string
  value: unknown
  node: WorkflowRunNode
  root: "input" | "output"
}) {
  const baseUrl = client.getConfig().baseUrl ?? window.location.origin
  const fileLinkForPath = (pathSegments: readonly string[]) => ({
    inlineUrl: workflowNodeFileContentUrl({
      baseUrl,
      runId: node.workflowRunId,
      nodeKey: node.nodeKey,
      root,
      pathSegments,
    }),
    downloadUrl: workflowNodeFileContentUrl({
      baseUrl,
      runId: node.workflowRunId,
      nodeKey: node.nodeKey,
      root,
      pathSegments,
      disposition: "attachment",
    }),
  })
  return (
    <div className="min-w-0 bg-card p-4">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <StructuredValue value={value} fileLinkForPath={fileLinkForPath} />
    </div>
  )
}
