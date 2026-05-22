import type { ObjectSummary } from "@pario/client"
import {
  getProjectInfoOptions,
  listConnectorsOptions,
  listDatasetsOptions,
  listObjectsOptions,
  listObjectTypesOptions,
  listPipelinesOptions,
  listRulesOptions,
  listSyncsOptions,
} from "@pario/client/hooks"
import { useQuery } from "@tanstack/react-query"
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate } from "react-router-dom"
import { ConnectorDetailPage, ConnectorsPage } from "./components/ConnectorsPage"
import { EmptyState, EmptyStateIcons, GlassCard, LoadingSpinner } from "./components/common"
import { DatasetDetailPage, DatasetsPage } from "./components/DatasetsPage"
import { AppShell, Sidebar, type ViewMode } from "./components/layout"
import { ObjectDetailPage } from "./components/ObjectDetailPage"
import { ObjectsWorkbench } from "./components/ObjectsWorkbench"
import { ObjectTypeDetail } from "./components/ObjectTypeDetail"
import { OntologyExplorer } from "./components/OntologyExplorer"
import { PipelineDetailPage, PipelinesPage } from "./components/PipelinesPage"
import { RuleDetailPage, RulesPage } from "./components/RulesPage"
import { SyncDetailPage, SyncsPage } from "./components/SyncsPage"
import { type TelemetryUpdate, useWebSocket } from "./hooks/useWebSocket"
import { cn } from "./lib/utils"

interface ProjectSidebarData {
  objects: ObjectSummary[]
  selectedObjectId: string | null
  datasetCount: number
  connectorCount: number
  syncCount: number
  pipelineCount: number
  ruleCount: number
  ontologyCount: number
  connected: boolean
}

const SidebarDataContext = createContext<{
  sidebarData: ProjectSidebarData | null
  setSidebarData: (data: ProjectSidebarData | null) => void
}>({ sidebarData: null, setSidebarData: () => {} })

const KNOWN_VIEWS = new Set([
  "home",
  "datasets",
  "connectors",
  "syncs",
  "pipelines",
  "rules",
  "ontology",
])
const emptyObjectList: ObjectSummary[] = []

function getViewModeFromPath(pathname: string): ViewMode {
  if (pathname === "/" || pathname === "") return "home"
  const segments = pathname.split("/").filter(Boolean)
  const view = segments[0]
  if (view && KNOWN_VIEWS.has(view)) return view as ViewMode
  return "home"
}

function AppLayout() {
  const navigate = useNavigate()
  const location = useLocation()

  const [sidebarData, setSidebarData] = useState<ProjectSidebarData | null>(null)

  const { data: projectInfo } = useQuery({
    ...getProjectInfoOptions(),
    retry: false,
  })

  const selectedProject =
    projectInfo === undefined
      ? null
      : {
          name: projectInfo.id,
          type: projectInfo.type,
        }

  const viewMode = getViewModeFromPath(location.pathname)

  const handleViewChange = (mode: ViewMode) => {
    if (mode === "home") {
      navigate("/")
      return
    }
    navigate(`/${mode}`)
  }

  const sidebar = (
    <Sidebar
      selectedProject={selectedProject}
      connected={sidebarData?.connected ?? false}
      viewMode={viewMode}
      onViewChange={handleViewChange}
      objects={sidebarData?.objects ?? []}
      selectedObjectId={sidebarData?.selectedObjectId ?? null}
      onSelectObject={(objectId) => {
        navigate(`/${objectId}`)
      }}
      connectorCount={sidebarData?.connectorCount ?? 0}
      datasetCount={sidebarData?.datasetCount ?? 0}
      syncCount={sidebarData?.syncCount ?? 0}
      pipelineCount={sidebarData?.pipelineCount ?? 0}
      ruleCount={sidebarData?.ruleCount ?? 0}
      ontologyCount={sidebarData?.ontologyCount ?? 0}
      showObjectList={false}
    />
  )

  return (
    <SidebarDataContext.Provider value={{ sidebarData, setSidebarData }}>
      <AppShell
        sidebar={sidebar}
        currentProjectName={selectedProject?.name ?? null}
        viewMode={viewMode}
        onViewChange={handleViewChange}
      >
        <Outlet />
      </AppShell>
    </SidebarDataContext.Provider>
  )
}

function ProjectWorkspace() {
  const navigate = useNavigate()
  const location = useLocation()
  const pathSegments = location.pathname.split("/").filter(Boolean)
  const firstSegment = pathSegments[0]
  const objectIdFromUrl = firstSegment && !KNOWN_VIEWS.has(firstSegment) ? firstSegment : null
  const { setSidebarData } = useContext(SidebarDataContext)

  const [latestUpdates, setLatestUpdates] = useState<Record<string, TelemetryUpdate>>({})

  const {
    data: projectInfo,
    isLoading: projectLoading,
    isError: projectError,
  } = useQuery({
    ...getProjectInfoOptions(),
    retry: false,
  })
  const resolvedProjectName = projectInfo?.id ?? ""

  useEffect(() => {
    if (!resolvedProjectName) return
    setLatestUpdates({})
  }, [resolvedProjectName])

  const objectsQuery = useQuery({
    ...listObjectsOptions(),
    enabled: !!projectInfo,
  })
  const objects = objectsQuery.data ?? emptyObjectList
  const { isLoading: objectsLoading } = objectsQuery

  const { data: objectTypes = [] } = useQuery({
    ...listObjectTypesOptions(),
    enabled: !!projectInfo,
  })

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

  const { data: rules = [] } = useQuery({
    ...listRulesOptions(),
    enabled: !!projectInfo,
  })

  const handleUpdate = useCallback(
    (update: TelemetryUpdate) => {
      if (resolvedProjectName && update.projectName !== resolvedProjectName) return

      const key = `${update.projectName}:${update.objectId}:${update.propertyId}`
      setLatestUpdates((previous) => ({
        ...previous,
        [key]: update,
      }))
    },
    [resolvedProjectName]
  )

  const { connected } = useWebSocket(handleUpdate, resolvedProjectName || "default")

  const selectedObjectIdForSidebar = objectIdFromUrl

  useEffect(() => {
    setSidebarData({
      objects,
      selectedObjectId: selectedObjectIdForSidebar,
      datasetCount: datasets.length,
      connectorCount: connectors.length,
      syncCount: syncs.length,
      pipelineCount: pipelines.length,
      ruleCount: rules.length,
      ontologyCount: objectTypes.length,
      connected,
    })
  }, [
    objects,
    selectedObjectIdForSidebar,
    datasets.length,
    connectors.length,
    syncs.length,
    pipelines.length,
    rules.length,
    objectTypes.length,
    connected,
    setSidebarData,
  ])

  useEffect(() => {
    return () => setSidebarData(null)
  }, [setSidebarData])

  const latestProjectUpdates = useMemo(
    () =>
      Object.values(latestUpdates).filter((update) => update.projectName === resolvedProjectName),
    [latestUpdates, resolvedProjectName]
  )

  const objectLookup = useMemo(
    () => Object.fromEntries(objects.map((object) => [object.id, object])),
    [objects]
  )

  const toProjectPath = (suffix: string) => `/${suffix}`

  if (projectLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoadingSpinner text="Loading project..." />
      </div>
    )
  }

  if (projectError || !projectInfo) {
    return (
      <div className="flex h-full items-center justify-center p-4 sm:p-8">
        <GlassCard className="max-w-md text-center">
          <EmptyState
            icon={EmptyStateIcons.cube}
            title="Project unavailable"
            description="Could not load current project metadata."
          />
          <button
            onClick={() => window.location.reload()}
            className="mt-2 rounded-lg border border-border/60 bg-card/60 px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-border hover:bg-accent/40 hover:text-foreground"
          >
            Retry
          </button>
        </GlassCard>
      </div>
    )
  }

  const constrained = (children: React.ReactNode) => (
    <div className={cn("mx-auto w-full max-w-7xl min-w-0 p-3 sm:p-4 lg:p-6")}>{children}</div>
  )

  return (
    <Routes>
      <Route path="pipelines/:pipelineId" element={<PipelineDetailPage />} />
      <Route
        path="*"
        element={constrained(
          <Routes>
            <Route
              index
              element={
                <ObjectsWorkbench
                  projectName={resolvedProjectName}
                  objects={objects}
                  loading={objectsLoading}
                  selectedObjectId={selectedObjectIdForSidebar}
                  latestProjectUpdates={latestProjectUpdates}
                  onSelectObject={(objectId) => navigate(toProjectPath(objectId))}
                />
              }
            />
            <Route path="home" element={<Navigate to="/" replace />} />
            <Route path="objects" element={<Navigate to="/" replace />} />
            <Route path="datasets" element={<DatasetsPage />} />
            <Route path="datasets/:datasetId" element={<DatasetDetailPage />} />
            <Route path="connectors" element={<ConnectorsPage />} />
            <Route path="connectors/:connectorId" element={<ConnectorDetailPage />} />
            <Route path="syncs" element={<SyncsPage />} />
            <Route path="syncs/:syncId" element={<SyncDetailPage />} />
            <Route path="pipelines" element={<PipelinesPage />} />
            <Route path="rules" element={<RulesPage />} />
            <Route path="rules/:ruleId" element={<RuleDetailPage />} />
            <Route
              path="ontology"
              element={
                <OntologyExplorer
                  onSelectType={(typeId) => navigate(toProjectPath(`ontology/${typeId}`))}
                />
              }
            />
            <Route path="ontology/:typeId" element={<ObjectTypeDetail />} />
            <Route
              path=":objectId"
              element={
                <ObjectDetailPage
                  projectName={resolvedProjectName}
                  latestUpdates={latestUpdates}
                  objectLookup={objectLookup}
                />
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        )}
      />
    </Routes>
  )
}

export default function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="*" element={<ProjectWorkspace />} />
      </Route>
    </Routes>
  )
}
