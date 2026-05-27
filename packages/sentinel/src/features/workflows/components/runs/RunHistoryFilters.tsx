import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@pario/ui/components"
import { ListFilter, X } from "lucide-react"
import {
  allWorkflowRunStatuses,
  readStatusFilter,
  statusLabels,
  type WorkflowRunStatusFilter,
  type WorkflowSummary,
} from "../../utils/workflows"

export function RunHistoryFilters({
  workflows,
  workflowId,
  status,
  onWorkflowIdChange,
  onStatusChange,
  onClear,
}: {
  workflows: readonly WorkflowSummary[]
  workflowId: string
  status: WorkflowRunStatusFilter
  onWorkflowIdChange: (workflowId: string) => void
  onStatusChange: (status: WorkflowRunStatusFilter) => void
  onClear: () => void
}) {
  const selectedWorkflowIsKnown =
    workflowId === "all" || workflows.some((workflow) => workflow.id === workflowId)
  const filtered = workflowId !== "all" || status !== "all"
  const activeFilterCount = Number(workflowId !== "all") + Number(status !== "all")

  return (
    <div className="flex flex-col gap-3 py-1 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <ListFilter className="h-4 w-4" />
        </span>
        <span className="text-sm font-medium text-foreground">Filters</span>
        {filtered ? (
          <span className="rounded-md border border-border bg-muted/50 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
            {activeFilterCount} active
          </span>
        ) : null}
      </div>

      <div className="grid w-full gap-2 sm:w-auto sm:grid-cols-[minmax(12rem,18rem)_12rem_auto]">
        <Select value={workflowId} onValueChange={onWorkflowIdChange}>
          <SelectTrigger size="sm" className="w-full min-w-0 bg-card text-sm">
            <SelectValue placeholder="All workflows" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All workflows</SelectItem>
            {!selectedWorkflowIsKnown ? (
              <SelectItem value={workflowId}>{workflowId}</SelectItem>
            ) : null}
            {workflows.map((workflow) => (
              <SelectItem key={workflow.id} value={workflow.id}>
                {workflow.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={status} onValueChange={(value) => onStatusChange(readStatusFilter(value))}>
          <SelectTrigger size="sm" className="w-full bg-card text-sm">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {allWorkflowRunStatuses.map((runStatus) => (
              <SelectItem key={runStatus} value={runStatus}>
                {statusLabels[runStatus]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {filtered ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClear}
            className="h-8 justify-start px-2 text-muted-foreground hover:text-foreground sm:justify-center sm:px-3"
          >
            <X className="h-3.5 w-3.5" />
            <span>Clear</span>
          </Button>
        ) : null}
      </div>
    </div>
  )
}
