import { Ban, CheckCircle2, CircleDashed, Hourglass, TimerReset, XCircle } from "lucide-react"
import type { WorkflowNodeStatus, WorkflowRunStatus } from "./utils"

export function WorkflowRunStatusIcon({
  status,
}: {
  status: WorkflowRunStatus | WorkflowNodeStatus
}) {
  if (status === "queued") return <CircleDashed className="h-3 w-3" />
  if (status === "running") return <TimerReset className="h-3 w-3 animate-spin" />
  if (status === "waiting") return <Hourglass className="h-3 w-3" />
  if (status === "succeeded") return <CheckCircle2 className="h-3 w-3" />
  if (status === "failed") return <XCircle className="h-3 w-3" />
  return <Ban className="h-3 w-3" />
}
