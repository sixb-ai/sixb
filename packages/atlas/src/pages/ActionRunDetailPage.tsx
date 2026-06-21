import { getActionRunOptions } from "@sixb/client/hooks"
import { Card, CardContent } from "@sixb/ui/components"
import { useQuery } from "@tanstack/react-query"
import { Navigate, useParams } from "react-router-dom"
import { ErrorPage, JsonPreview, LoadingPage, PageFrame } from "../components/common"
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
    refetchInterval: (query) => {
      const status = query.state.data?.status
      return status === "queued" || status === "running" ? 2000 : false
    },
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
        <Card>
          <CardContent className="p-4">
            <div className="mb-3 flex items-center gap-2">
              <ActionRunStatusBadge status={run.status} />
              <span className="text-sm font-medium text-foreground">Failure</span>
            </div>
            <JsonPreview value={run.error} />
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardContent className="p-4">
            <JsonPreview label="Params" value={run.params} />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <JsonPreview label="Writeback" value={run.writeback ?? null} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="space-y-3 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Local commit
          </p>
          {run.commit ? (
            <ActionRunDiffSummary diff={run.commit.diff} />
          ) : (
            <p className="text-sm text-muted-foreground">No local commit recorded.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4">
          <JsonPreview label="Effects" value={run.effects ?? null} />
        </CardContent>
      </Card>
    </PageFrame>
  )
}
