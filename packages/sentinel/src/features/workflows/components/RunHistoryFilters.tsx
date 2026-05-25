import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@pario/ui/components"
import { ListFilter } from "lucide-react"
import {
  allWorkflowRunStatuses,
  readStatusFilter,
  statusLabels,
  type WorkflowRunStatusFilter,
  type WorkflowSummary,
} from "../utils/workflows"

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

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <ListFilter className="h-4 w-4 text-muted-foreground" />
        Filters
      </div>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,16rem)_12rem_auto]">
        <Select value={workflowId} onValueChange={onWorkflowIdChange}>
          <SelectTrigger className="h-8 w-full bg-background text-sm">
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
          <SelectTrigger className="h-8 w-full bg-background text-sm">
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
            className="justify-start sm:justify-center"
          >
            Clear
          </Button>
        ) : null}
      </div>
    </div>
  )
}
