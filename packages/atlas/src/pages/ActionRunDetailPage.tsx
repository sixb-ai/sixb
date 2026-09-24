import { client } from "@sixb/client"
import { getActionRunOptions, listActionsOptions } from "@sixb/client/hooks"
import { Card, CardContent } from "@sixb/ui/components"
import { useQuery } from "@tanstack/react-query"
import { useMemo } from "react"
import { Navigate, useParams } from "react-router-dom"
import { DataPanel, ErrorPage, LoadingPage, PageFrame } from "../components/common"
import { SixbFailureSummary } from "../components/SixbFailureSummary"
import { useActionLiveUpdates } from "../features/actions/hooks/useActionLiveUpdates"
import { useOntologyValueTypes } from "../features/objects/hooks/useOntologyValueTypes"
import { actionRunFileContentUrl } from "../lib/files"
import { fieldRecordSchema, valueSchema } from "../lib/valueSchema"
import { ActionRunMetaGrid, ActionRunStatusBadge, formatSubject } from "./ActionsPage"

export function ActionRunDetailPage() {
  const { runId = "" } = useParams()
  const runQuery = useQuery({
    ...getActionRunOptions({ path: { runId } }),
    enabled: runId.length > 0,
  })
  const actionsQuery = useQuery(listActionsOptions())
  const actionParamSchemas = useMemo(
    () => (actionsQuery.data ?? []).flatMap((action) => action.params.map((param) => param.schema)),
    [actionsQuery.data]
  )
  const ontology = useOntologyValueTypes(actionParamSchemas)
  const status = runQuery.data?.status
  useActionLiveUpdates({
    runId,
    enabled:
      runId.length > 0 && (status === undefined || status === "queued" || status === "running"),
  })

  if (!runId) {
    return <Navigate to="/actions?tab=runs" replace />
  }

  if (runQuery.isLoading || actionsQuery.isLoading || ontology.isLoading) {
    return <LoadingPage label="Loading action run..." />
  }

  if (runQuery.isError || !runQuery.data) {
    return <ErrorPage title="Action run unavailable" description="Could not load action run." />
  }

  const run = runQuery.data
  // Params are declared by the action. A run whose action is no longer
  // registered has no schema left, so its params render as open values.
  const action = actionsQuery.data?.find((candidate) => candidate.id === run.actionId)
  const paramsSchema = action
    ? valueSchema(
        fieldRecordSchema(Object.fromEntries(action.params.map((param) => [param.id, param]))),
        ontology.valueTypes
      )
    : undefined
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
            <SixbFailureSummary failure={run.error} showDetails />
            <p className="mt-2 text-xs text-muted-foreground">
              Phase <span className="font-mono text-foreground">{run.error.details.phase}</span>
            </p>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-0">
          <CardContent className="p-5">
            <DataPanel
              label="Params"
              value={run.params}
              schema={paramsSchema}
              fileLinkForPath={paramFileLinkForPath}
            />
          </CardContent>
        </Card>

        {/* Writeback results and effects are whatever the handler returned: nothing declares
            them, so they render as open values. */}
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
