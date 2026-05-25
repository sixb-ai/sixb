import { Card, CardContent, CardHeader, CardTitle } from "@pario/ui/components"
import { KeyValue } from "../../../components/common"
import {
  formatDate,
  formatRunDuration,
  formatRunStartedDate,
  type WorkflowRunDetail,
} from "../utils/workflows"
import { StatusBadge } from "./StatusBadge"

export function RunSummaryCard({ run }: { run: WorkflowRunDetail }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <CardTitle>Summary</CardTitle>
          <StatusBadge status={run.status} />
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <KeyValue label="Workflow" value={run.workflowId} to={`/workflows/${run.workflowId}`} />
        <KeyValue label="Project" value={run.projectId} />
        <KeyValue label="Queued" value={formatDate(run.queuedAt)} />
        <KeyValue label="Started" value={formatRunStartedDate(run)} />
        <KeyValue label="Finished" value={formatDate(run.finishedAt)} />
        <KeyValue label="Duration" value={formatRunDuration(run)} />
        {run.error ? <KeyValue label="Error" value={run.error} /> : null}
      </CardContent>
    </Card>
  )
}
