import { Badge, Card, CardContent } from "@sixb/ui/components"
import { Box, UserCheck, Workflow, Zap } from "lucide-react"
import type { WorkflowNode } from "../../utils/workflows"
import { SchemaShape } from "./SchemaShape"

export function WorkflowNodeRow({ node, index }: { node: WorkflowNode; index: number }) {
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardContent className="p-0">
        <div className="flex items-start gap-3 p-4">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted font-mono text-sm font-medium tabular-nums text-muted-foreground">
            {index + 1}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <h3 className="truncate text-sm font-medium text-foreground">{node.key}</h3>
              <Badge
                variant="secondary"
                className="shrink-0 gap-1 rounded-md px-1.5 py-0 text-[10px]"
              >
                <NodeTypeIcon type={node.type} />
                {node.type}
              </Badge>
            </div>
            <NodeMeta node={node} />
          </div>
          <NodeSummary node={node} />
        </div>

        {node.type === "step" ? (
          <div className="grid gap-px border-t border-border/60 bg-border/40 lg:grid-cols-2">
            <SchemaSection label="Input" fields={node.input} emptyLabel="No input fields" />
            <SchemaSection label="Output" fields={node.output} emptyLabel="No output fields" />
          </div>
        ) : node.type === "intervention" ? (
          <div className="grid gap-px border-t border-border/60 bg-border/40 lg:grid-cols-2">
            <SchemaSection label="Input" fields={node.input} emptyLabel="No input fields" />
            <SchemaSection
              label="Response"
              fields={node.response}
              emptyLabel="No response fields"
            />
          </div>
        ) : (
          <div className="border-t border-border/60 bg-muted/20">
            <SchemaSection label="Params" fields={node.params} emptyLabel="No params" />
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function NodeMeta({ node }: { node: WorkflowNode }) {
  if (node.type === "action") {
    return (
      <p className="mt-0.5 truncate text-xs text-muted-foreground">
        Sends an action request to {node.targetObjectTypeId}.
      </p>
    )
  }

  if (node.type === "intervention") {
    return (
      <p className="mt-0.5 truncate text-xs text-muted-foreground">
        {node.description ?? "Waits for a human response."}
      </p>
    )
  }

  return <p className="mt-0.5 text-xs text-muted-foreground">Transforms workflow data.</p>
}

function NodeSummary({ node }: { node: WorkflowNode }) {
  if (node.type === "action") {
    return (
      <span className="hidden shrink-0 items-center gap-1.5 text-xs text-muted-foreground sm:inline-flex">
        <span>targets</span>
        <span className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-2 py-0.5 font-medium text-foreground">
          <Box className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
          {node.targetObjectTypeId}
        </span>
      </span>
    )
  }

  if (node.type === "intervention") {
    return (
      <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground sm:inline">
        {fieldCountLabel(Object.keys(node.input ?? {}).length, "input")} ·{" "}
        {fieldCountLabel(Object.keys(node.response ?? {}).length, "response")}
      </span>
    )
  }

  return (
    <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground sm:inline">
      {fieldCountLabel(Object.keys(node.input ?? {}).length, "input")} ·{" "}
      {fieldCountLabel(Object.keys(node.output ?? {}).length, "output")}
    </span>
  )
}

function NodeTypeIcon({ type }: { type: WorkflowNode["type"] }) {
  if (type === "step") return <Workflow className="h-3 w-3" />
  if (type === "intervention") return <UserCheck className="h-3 w-3" />
  return <Zap className="h-3 w-3" />
}

function SchemaSection({
  label,
  fields,
  emptyLabel,
}: {
  label: string
  fields: Readonly<Record<string, unknown>>
  emptyLabel: string
}) {
  const count = Object.keys(fields ?? {}).length
  return (
    <div className="min-w-0 bg-card p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
        <span className="text-xs tabular-nums text-muted-foreground">
          {fieldCountLabel(count, "field")}
        </span>
      </div>
      <SchemaShape fields={fields} emptyLabel={emptyLabel} />
    </div>
  )
}

function fieldCountLabel(count: number, label: string) {
  return `${count} ${label}${count === 1 ? "" : "s"}`
}
