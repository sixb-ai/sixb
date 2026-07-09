import { client } from "@sixb/client"
import { getActionRunOptions } from "@sixb/client/hooks"
import { logs } from "@sixb/client/logs"
import { Card, CardContent, Tabs, TabsContent, TabsList, TabsTrigger } from "@sixb/ui/components"
import { useQuery } from "@tanstack/react-query"
import { Navigate, useParams, useSearchParams } from "react-router-dom"
import { DataPanel, ErrorPage, LoadingPage, PageFrame } from "../components/common"
import { useActionLiveUpdates } from "../features/actions/hooks/useActionLiveUpdates"
import { LogConsole } from "../features/logging/LogConsole"
import { actionRunFileContentUrl } from "../lib/files"
import {
  ActionRunDiffSummary,
  ActionRunMetaGrid,
  ActionRunStatusBadge,
  formatSubject,
} from "./ActionsPage"

const TAB_VALUES = ["overview", "logs"] as const
type TabValue = (typeof TAB_VALUES)[number]
const DEFAULT_TAB: TabValue = "overview"

function isTabValue(value: string | null): value is TabValue {
  return value !== null && (TAB_VALUES as readonly string[]).includes(value)
}

export function ActionRunDetailPage() {
  const { runId = "" } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const tabParam = searchParams.get("tab")
  const activeTab: TabValue = isTabValue(tabParam) ? tabParam : DEFAULT_TAB
  const setActiveTab = (next: string) => {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev)
        if (next === DEFAULT_TAB) {
          params.delete("tab")
        } else {
          params.set("tab", next)
        }
        return params
      },
      { replace: true }
    )
  }
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

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList variant="line">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4 pt-4">
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
                <DataPanel
                  label="Params"
                  value={run.params}
                  fileLinkForPath={paramFileLinkForPath}
                />
              </CardContent>
            </Card>

            <Card className="p-0">
              <CardContent className="p-5">
                <DataPanel
                  label="Writeback"
                  value={run.writeback ?? null}
                  emptyLabel="No writeback"
                />
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
        </TabsContent>

        <TabsContent value="logs" className="pt-4">
          <LogConsole builder={logs.actions().run(run.id)} history={500} className="h-[32rem]" />
        </TabsContent>
      </Tabs>
    </PageFrame>
  )
}
