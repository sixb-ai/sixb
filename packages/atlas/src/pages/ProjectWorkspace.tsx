import type { ObjectSummary } from "@sixb/client"
import {
  getProjectInfoOptions,
  getWorkflowRunOptions,
  listActionsOptions,
  listAgentsOptions,
  listConnectorsOptions,
  listDatasetsOptions,
  listObjectsPageOptions,
  listObjectTypesOptions,
  listPipelinesOptions,
  listProjectionsOptions,
  listRulesOptions,
  listSyncsOptions,
  listWorkflowsOptions,
  objectCountOptions,
} from "@sixb/client/hooks"
import { Button, Card, EmptyState } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { useQueries, useQuery } from "@tanstack/react-query"
import { Box, Loader2 } from "lucide-react"
import {
  type ReactNode,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react"
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom"
import { SidebarDataContext } from "../components/layout/sidebarData"
import { KNOWN_VIEWS } from "../components/layout/viewMode"
import { SettingsAccessGate } from "../components/SettingsAccessGate"
import {
  getObjectSortPreference,
  type ObjectSortPreference,
  setObjectSortPreference,
} from "../lib/userPreferences"
import { ObjectsWorkbench, type ObjectTypePreviewSection } from "./ObjectsWorkbench"
import {
  ActionRunDetailPage,
  ActionsPage,
  ConnectorDetailPage,
  ConnectorsPage,
  DatasetDetailPage,
  DatasetsPage,
  LogsPage,
  ObjectDetailPage,
  OntologyExplorer,
  PipelineDetailPage,
  PipelinesPage,
  ProjectionDetailPage,
  ProjectionsPage,
  RuleDetailPage,
  RulesPage,
  SettingsMembersPage,
  SettingsServiceAccountsPage,
  SettingsSessionsPage,
  SettingsTokensPage,
  SyncDetailPage,
  SyncsPage,
  WorkflowDetailPage,
  WorkflowsPage,
} from "./workspaceRoutes"

const emptyObjectList: ObjectSummary[] = []
const OBJECT_PAGE_SIZE = 300
const OBJECT_TYPE_PREVIEW_LIMIT = 12

export function ProjectWorkspace() {
  const navigate = useNavigate()
  const location = useLocation()
  const pathSegments = location.pathname.split("/").filter(Boolean)
  const firstSegment = pathSegments[0]
  const objectIdFromUrl = firstSegment && !KNOWN_VIEWS.has(firstSegment) ? firstSegment : null
  const { setSidebarData } = useContext(SidebarDataContext)

  const [objectSortBy, setObjectSortBy] = useState<ObjectSortPreference>(getObjectSortPreference)
  const [searchParams, setSearchParams] = useSearchParams()
  const classFilter = searchParams.get("class") || null
  const selectedOntologyTypeId = location.pathname === "/ontology" ? searchParams.get("type") : null
  const ontologyDetailsOpen =
    location.pathname === "/ontology" &&
    selectedOntologyTypeId !== null &&
    searchParams.get("view") === "details"

  const setOntologyState = useCallback(
    (typeId: string | null, details: boolean, options?: { replace?: boolean }) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev)
          if (typeId) {
            params.set("type", typeId)
          } else {
            params.delete("type")
          }
          if (typeId && details) {
            params.set("view", "details")
          } else {
            params.delete("view")
          }
          if (!typeId) params.delete("tab")
          return params
        },
        { replace: options?.replace ?? true }
      )
    },
    [setSearchParams]
  )

  const setSelectedOntologyTypeId = useCallback(
    (typeId: string | null) => setOntologyState(typeId, false),
    [setOntologyState]
  )

  const openOntologyTypeDetails = useCallback(
    (typeId: string) => setOntologyState(typeId, true, { replace: false }),
    [setOntologyState]
  )

  const setClassFilter = useCallback(
    (next: string | null, options?: { replace?: boolean }) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev)
          if (next) {
            params.set("class", next)
          } else {
            params.delete("class")
          }
          params.delete("offset")
          return params
        },
        { replace: options?.replace ?? true }
      )
    },
    [setSearchParams]
  )

  const {
    data: projectInfo,
    isLoading: projectLoading,
    isError: projectError,
  } = useQuery({
    ...getProjectInfoOptions(),
    retry: false,
  })
  const resolvedProjectName = projectInfo?.id ?? ""

  const { data: objectTypes = [], isLoading: objectTypesLoading } = useQuery({
    ...listObjectTypesOptions(),
    enabled: !!projectInfo,
  })

  useEffect(() => {
    if (objectTypes.length === 0 || !classFilter) return
    if (!objectTypes.some((objectType) => objectType.id === classFilter)) {
      setClassFilter(null, { replace: true })
    }
  }, [classFilter, objectTypes, setClassFilter])

  const selectedObjectType = useMemo(
    () => objectTypes.find((objectType) => objectType.id === classFilter) ?? null,
    [classFilter, objectTypes]
  )

  const globalObjectCountQuery = useQuery({
    ...objectCountOptions(),
    enabled: !!projectInfo,
  })

  const objectTypePreviewQueries = useQueries({
    queries: objectTypes.map((objectType) => ({
      ...listObjectsPageOptions({
        query: {
          objectTypeId: objectType.id,
          limit: String(OBJECT_TYPE_PREVIEW_LIMIT),
          orderBy: objectSortBy,
          order: objectSortBy === "primaryId" ? "asc" : "desc",
        },
      }),
      enabled: !!projectInfo && !classFilter,
    })),
  })

  const objectTypeCountQueries = useQueries({
    queries: objectTypes.map((objectType, index) => ({
      ...objectCountOptions({
        query: {
          objectTypeId: objectType.id,
        },
      }),
      enabled:
        !!projectInfo &&
        !!classFilter &&
        typeof objectTypePreviewQueries[index]?.data?.total !== "number",
    })),
  })

  const objectTypePreviewSections = useMemo<ObjectTypePreviewSection[]>(() => {
    return objectTypes
      .map((objectType, index) => {
        const previewQuery = objectTypePreviewQueries[index]
        const page = previewQuery?.data
        const total = page?.total ?? 0

        return {
          objectTypeId: objectType.id,
          objects: page?.objects ?? emptyObjectList,
          total,
        }
      })
      .filter((section) => section.total > 0 || section.objects.length > 0)
  }, [objectTypes, objectTypePreviewQueries])

  const objectTypeCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (let i = 0; i < objectTypes.length; i += 1) {
      const count = objectTypeCountQueries[i]?.data ?? objectTypePreviewQueries[i]?.data?.total
      if (typeof count === "number") counts.set(objectTypes[i].id, count)
    }
    return counts
  }, [objectTypes, objectTypeCountQueries, objectTypePreviewQueries])

  const objectTypeTotal = useMemo(() => {
    if (objectTypes.length === 0 || objectTypeCounts.size !== objectTypes.length) return undefined

    let total = 0
    for (const objectType of objectTypes) {
      const count = objectTypeCounts.get(objectType.id)
      if (typeof count !== "number") return undefined
      total += count
    }
    return total
  }, [objectTypes, objectTypeCounts])

  const allObjectsTotal = globalObjectCountQuery.data ?? objectTypeTotal ?? 0

  const overviewLoading =
    !classFilter &&
    (objectTypesLoading ||
      (objectTypes.length > 0 && objectTypePreviewQueries.some((query) => query.isLoading)))

  const { data: connectors = [] } = useQuery({
    ...listConnectorsOptions(),
    enabled: !!projectInfo,
  })

  const { data: datasets = [] } = useQuery({
    ...listDatasetsOptions(),
    enabled: !!projectInfo,
  })

  const { data: syncs = [] } = useQuery({
    ...listSyncsOptions(),
    enabled: !!projectInfo,
  })

  const { data: pipelines = [] } = useQuery({
    ...listPipelinesOptions(),
    enabled: !!projectInfo,
  })

  const { data: projections } = useQuery({
    ...listProjectionsOptions(),
    enabled: !!projectInfo,
  })
  const projectionCount = projections
    ? projections.objectProjections.length +
      projections.linkProjections.length +
      projections.telemetryProjections.length
    : 0

  const { data: workflows = [] } = useQuery({
    ...listWorkflowsOptions(),
    enabled: !!projectInfo,
  })

  const { data: actions = [] } = useQuery({
    ...listActionsOptions(),
    enabled: !!projectInfo,
  })

  const { data: rules = [] } = useQuery({
    ...listRulesOptions(),
    enabled: !!projectInfo,
  })

  const { data: agents = [] } = useQuery({
    ...listAgentsOptions(),
    enabled: !!projectInfo,
  })

  const selectedObjectIdForSidebar = objectIdFromUrl

  useEffect(() => {
    setSidebarData({
      objectCount: globalObjectCountQuery.data ?? objectTypeTotal,
      datasetCount: datasets.length,
      connectorCount: connectors.length,
      syncCount: syncs.length,
      pipelineCount: pipelines.length,
      projectionCount,
      workflowCount: workflows.length,
      actionCount: actions.length,
      agentCount: agents.length,
      ruleCount: rules.length,
      ontologyCount: objectTypes.length,
    })
  }, [
    globalObjectCountQuery.data,
    objectTypeTotal,
    datasets.length,
    connectors.length,
    syncs.length,
    pipelines.length,
    projectionCount,
    workflows.length,
    actions.length,
    agents.length,
    rules.length,
    objectTypes.length,
    setSidebarData,
  ])

  useEffect(() => {
    return () => setSidebarData(null)
  }, [setSidebarData])

  const objectLookup = useMemo(
    () =>
      Object.fromEntries(
        objectTypePreviewSections
          .flatMap((section) => section.objects)
          .map((object) => [object.id, object])
      ),
    [objectTypePreviewSections]
  )

  const toProjectPath = (suffix: string) => `/${suffix}`

  const handleObjectSortByChange = (sortBy: ObjectSortPreference) => {
    setObjectSortBy(sortBy)
    setObjectSortPreference(sortBy)
  }

  if (projectLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex items-center gap-3 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Loading project...</span>
        </div>
      </div>
    )
  }

  if (projectError || !projectInfo) {
    return (
      <div className="flex h-full items-center justify-center p-4 sm:p-8">
        <Card className="mx-auto max-w-md p-6 text-center">
          <EmptyState
            icon={<Box className="size-12 stroke-1" />}
            title="Project unavailable"
            description="Could not load current project metadata."
          />
          <Button
            variant="outline"
            size="sm"
            className="mx-auto mt-2"
            onClick={() => window.location.reload()}
          >
            Retry
          </Button>
        </Card>
      </div>
    )
  }

  const ontologyWorkspace = location.pathname === "/ontology"
  const constrained = (children: ReactNode) => (
    <div
      className={cn(
        ontologyWorkspace
          ? "h-full min-h-0 w-full"
          : "mx-auto w-full max-w-7xl min-w-0 p-3 sm:p-4 lg:p-6"
      )}
    >
      {children}
    </div>
  )

  // BrowserRouter transitions keep the current route visible while an intent-preloaded chunk
  // resolves. The destination page then owns the only loading state: its actual data.
  return (
    <Suspense fallback={null}>
      <Routes>
        <Route path="pipelines/:pipelineId" element={<PipelineDetailPage />} />
        <Route path="datasets/:datasetId" element={<DatasetDetailPage />} />
        <Route path="actions" element={<ActionsPage />} />
        <Route path="actions/runs/:runId" element={<ActionRunDetailPage />} />
        <Route path="workflows" element={<WorkflowsPage />} />
        <Route path="workflows/:workflowId" element={<WorkflowDetailPage />} />
        <Route path="logs" element={<LogsPage />} />
        <Route path="runs" element={<RunsTabRedirect />} />
        <Route path="runs/:runId" element={<RunRedirect />} />
        <Route
          path="*"
          element={constrained(
            <Routes>
              <Route
                index
                element={
                  <ObjectsWorkbench
                    projectName={resolvedProjectName}
                    objectPageSize={OBJECT_PAGE_SIZE}
                    allObjectsTotal={allObjectsTotal}
                    objectTypeCounts={objectTypeCounts}
                    overviewSections={objectTypePreviewSections}
                    overviewLoading={overviewLoading}
                    objectTypesLoading={objectTypesLoading}
                    sortBy={objectSortBy}
                    classFilter={classFilter}
                    selectedObjectType={selectedObjectType}
                    selectedObjectId={selectedObjectIdForSidebar}
                    onSortByChange={handleObjectSortByChange}
                    onClassFilterChange={setClassFilter}
                    onSelectObject={(objectId) => navigate(toProjectPath(objectId))}
                  />
                }
              />
              <Route path="home" element={<Navigate to="/" replace />} />
              <Route path="objects" element={<Navigate to="/" replace />} />
              <Route path="datasets" element={<DatasetsPage />} />
              <Route path="connectors" element={<ConnectorsPage />} />
              <Route path="connectors/:connectorId" element={<ConnectorDetailPage />} />
              <Route path="syncs" element={<SyncsPage />} />
              <Route path="syncs/:syncId" element={<SyncDetailPage />} />
              <Route path="projections" element={<ProjectionsPage />} />
              <Route path="projections/:projectionId" element={<ProjectionDetailPage />} />
              <Route path="pipelines" element={<PipelinesPage />} />
              <Route path="rules" element={<RulesPage />} />
              <Route path="rules/:ruleId" element={<RuleDetailPage />} />
              <Route path="settings" element={<Navigate to="/settings/members" replace />} />
              <Route
                path="settings/tokens"
                element={
                  <SettingsAccessGate>
                    <SettingsTokensPage />
                  </SettingsAccessGate>
                }
              />
              <Route
                path="settings/members"
                element={
                  <SettingsAccessGate>
                    <SettingsMembersPage />
                  </SettingsAccessGate>
                }
              />
              <Route
                path="settings/service-accounts"
                element={
                  <SettingsAccessGate>
                    <SettingsServiceAccountsPage />
                  </SettingsAccessGate>
                }
              />
              <Route
                path="settings/sessions"
                element={
                  <SettingsAccessGate>
                    <SettingsSessionsPage />
                  </SettingsAccessGate>
                }
              />
              <Route
                path="ontology"
                element={
                  <OntologyExplorer
                    objectTypeCounts={objectTypeCounts}
                    selectedTypeId={selectedOntologyTypeId}
                    detailsOpen={ontologyDetailsOpen}
                    onSelectedTypeChange={setSelectedOntologyTypeId}
                    onOpenType={openOntologyTypeDetails}
                    onViewObjects={(typeId) => {
                      navigate(toProjectPath(`?class=${encodeURIComponent(typeId)}`))
                    }}
                  />
                }
              />
              <Route path="ontology/:typeId" element={<OntologyTypeRedirect />} />
              <Route
                path=":objectId"
                element={
                  <ObjectDetailPage projectName={resolvedProjectName} objectLookup={objectLookup} />
                }
              />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          )}
        />
      </Routes>
    </Suspense>
  )
}

function OntologyTypeRedirect() {
  const { typeId } = useParams<{ typeId: string }>()
  if (!typeId) return <Navigate to="/ontology" replace />
  const params = new URLSearchParams({ type: typeId, view: "details" })
  return <Navigate to={`/ontology?${params.toString()}`} replace />
}

function RunsTabRedirect() {
  const [searchParams] = useSearchParams()
  const params = new URLSearchParams(searchParams)
  params.set("tab", "runs")

  return <Navigate to={`/workflows?${params.toString()}`} replace />
}

// A run is inspected on its workflow's canvas, so resolve the run's workflow and
// hand off to `/workflows/:workflowId?run=:runId`.
function RunRedirect() {
  const { runId = "" } = useParams()
  const runQuery = useQuery({
    ...getWorkflowRunOptions({ path: { runId } }),
    enabled: runId.length > 0,
  })

  if (!runId) {
    return <Navigate to="/workflows?tab=runs" replace />
  }

  if (runQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex items-center gap-3 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Loading run...</span>
        </div>
      </div>
    )
  }

  const workflowId = runQuery.data?.run.workflowId
  if (!workflowId) {
    return <Navigate to="/workflows?tab=runs" replace />
  }

  return <Navigate to={`/workflows/${workflowId}?run=${runId}`} replace />
}
