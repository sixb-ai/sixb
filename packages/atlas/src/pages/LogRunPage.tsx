import { type LogRunKind, type LogsBuilder, logs } from "@sixb/client/logs"
import { Badge } from "@sixb/ui/components"
import { Navigate, useParams } from "react-router-dom"
import { PageFrame } from "../components/common"
import { LogConsole } from "../features/logging/LogConsole"

const RUN_KIND_LABELS: Record<LogRunKind, string> = {
  sync: "Sync",
  pipeline: "Pipeline",
  workflow: "Workflow",
  action: "Action",
}

export function LogRunPage() {
  const { kind, runId = "" } = useParams()
  if (!isLogRunKind(kind) || !runId) return <Navigate to="/logs" replace />

  if (kind === "workflow") {
    return <Navigate to={`/runs/${encodeURIComponent(runId)}?tab=logs`} replace />
  }
  if (kind === "action") {
    return <Navigate to={`/actions/runs/${encodeURIComponent(runId)}?tab=logs`} replace />
  }

  return (
    <PageFrame
      eyebrow={`${RUN_KIND_LABELS[kind]} run`}
      title={<span className="font-mono text-[0.8em]">{runId}</span>}
      description="Retained history and live output for this run."
      backTo="/logs"
      backLabel="All logs"
      actions={<Badge variant="outline">{kind}</Badge>}
    >
      <LogConsole builder={builderFor(kind, runId)} history={500} className="h-[70vh] min-h-96" />
    </PageFrame>
  )
}

function builderFor(kind: LogRunKind, runId: string): LogsBuilder {
  switch (kind) {
    case "sync":
      return logs.syncs().run(runId)
    case "pipeline":
      return logs.pipelines().run(runId)
    case "workflow":
      return logs.workflows().run(runId)
    case "action":
      return logs.actions().run(runId)
  }
}

function isLogRunKind(value: string | undefined): value is LogRunKind {
  return value === "sync" || value === "pipeline" || value === "workflow" || value === "action"
}
