import { client } from "@sixb/client"
import { getActionRunOptions } from "@sixb/client/hooks"
import { Card, CardContent } from "@sixb/ui/components"
import { useQuery } from "@tanstack/react-query"
import { Navigate, useParams } from "react-router-dom"
import { DataPanel, ErrorPage, LoadingPage, PageFrame } from "../components/common"
import { useActionLiveUpdates } from "../features/actions/hooks/useActionLiveUpdates"
import { actionRunFileContentUrl } from "../lib/files"
import { ActionRunMetaGrid, ActionRunStatusBadge, formatSubject } from "./ActionsPage"

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
  const baseUrl = client.getConfig().baseUrl ?? window.location.origin
  const paramFileLinkForPath = (pathSegments: readonly string[]) => ({
    inlineUrl: actionRunFileContentUrl({ baseUrl, runId: run.id, pathSegments }),
    downloadUrl: actionRunFileContentUrl({
      baseUrl,
      runId: run.id,
      pathSegments,
      disposition: "attachment",
    }),
  })

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
            <DataPanel label="Params" value={run.params} fileLinkForPath={paramFileLinkForPath} />
          </CardContent>
        </Card>

        <Card className="p-0">
          <CardContent className="p-5">
            <DataPanel label="Writeback" value={run.writeback ?? null} emptyLabel="No writeback" />
          </CardContent>
        </Card>
      </div>

      <Card className="p-0">
        <CardContent className="p-5">
          <DataPanel label="Effects" value={run.effects ?? null} emptyLabel="No effects" />
        </CardContent>
      </Card>
    </PageFrame>
  )
}
