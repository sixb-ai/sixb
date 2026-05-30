import { Badge } from "@pario/ui/components"
import { cn } from "@pario/ui/lib/utils"
import { Ban, CheckCircle2, CircleDashed, Hourglass, TimerReset, XCircle } from "lucide-react"
import {
  nodeStatusClasses,
  statusClasses,
  statusLabels,
  type WorkflowNodeStatus,
  type WorkflowRunStatus,
} from "../../utils/workflows"

export function StatusBadge({ status }: { status: WorkflowRunStatus }) {
  return (
    <Badge variant="outline" className={cn("gap-1.5 rounded-md", statusClasses[status])}>
      <WorkflowRunStatusIcon status={status} />
      {statusLabels[status]}
    </Badge>
  )
}

export function NodeStatusBadge({ status }: { status: WorkflowNodeStatus }) {
  return (
    <Badge variant="outline" className={cn("gap-1.5 rounded-md", nodeStatusClasses[status])}>
      <WorkflowRunStatusIcon status={status} />
      {statusLabels[status]}
    </Badge>
  )
}

function WorkflowRunStatusIcon({ status }: { status: WorkflowRunStatus | WorkflowNodeStatus }) {
  if (status === "queued") return <CircleDashed className="h-3 w-3" />
  if (status === "running") return <TimerReset className="h-3 w-3 animate-spin" />
  if (status === "waiting") return <Hourglass className="h-3 w-3" />
  if (status === "succeeded") return <CheckCircle2 className="h-3 w-3" />
  if (status === "failed") return <XCircle className="h-3 w-3" />
  return <Ban className="h-3 w-3" />
}
