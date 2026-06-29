import { getActionRunOptions } from "@sixb/client/hooks"
import { Card, CardContent } from "@sixb/ui/components"
import { useQuery } from "@tanstack/react-query"
import { Navigate, useParams } from "react-router-dom"
import { DataPanel, ErrorPage, LoadingPage, PageFrame } from "../components/common"
import { useActionLiveUpdates } from "../features/actions/hooks/useActionLiveUpdates"
import {
  ActionRunDiffSummary,
  ActionRunMetaGrid,
  ActionRunStatusBadge,
  formatSubject,
} from "./ActionsPage"

export function ActionRunDetailPage() {
  const { runId = "" } = useParams()
  const runQuery = useQuery({
    ...getActionRunOptions({ path: { runId } }),
    enabled: runId.length > 0,
  })
  const status = runQuery.data?.status
  useActionLiveUpdates({
    runId,
    enabled:
      runId.length > 0 && (status === undefined || status === "queued" || status === "running"),
  })

  if (!runId) {
    return <Navigate to="/actions?tab=runs" replace />
  }

  if (runQuery.isLoading) {
    return <LoadingPage label="Loading action run..." />
  }

  if (runQuery.isError || !runQuery.data) {
    return <ErrorPage title="Action run unavailable" description="Could not load action run." />
  }

  const run = runQuery.data

  return (
    <PageFrame
      eyebrow="Action run"
      title={run.id}
      description={
        <span>
          <span className="font-mono">{run.actionId}</span> on{" "}
          <span className="font-mono">{formatSubject(run.subject)}</span>
        </span>
      }
      backTo="/actions?tab=runs"
      backLabel="Back to action runs"
    >
      <ActionRunMetaGrid run={run} />

      {run.error ? (
        <Card className="p-0">
          <CardContent className="p-5">
            <div className="mb-3 flex items-center gap-2">
              <ActionRunStatusBadge status={run.status} />
              <span className="text-sm font-medium text-foreground">Failure</span>
            </div>
            <DataPanel value={run.error} />
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-0">
          <CardContent className="p-5">
            <DataPanel label="Params" value={run.params} />
          </CardContent>
        </Card>

        <Card className="p-0">
          <CardContent className="p-5">
            <DataPanel label="Writeback" value={run.writeback ?? null} emptyLabel="No writeback" />
          </CardContent>
        </Card>
      </div>

      <Card className="p-0">
        <CardContent className="space-y-3 p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Local commit
          </p>
          {run.commit ? (
            <ActionRunDiffSummary diff={run.commit.diff} />
          ) : (
            <p className="text-sm text-muted-foreground">No local commit recorded.</p>
          )}
        </CardContent>
      </Card>

      <Card className="p-0">
        <CardContent className="p-5">
          <DataPanel label="Effects" value={run.effects ?? null} emptyLabel="No effects" />
        </CardContent>
      </Card>
    </PageFrame>
  )
}
