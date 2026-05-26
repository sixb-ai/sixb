import type { ObjectSummary } from "@pario/client"
import {
  getProjectInfoOptions,
  listConnectorsOptions,
  listDatasetsOptions,
  listObjectsPageOptions,
  listObjectTypesOptions,
  listPipelinesOptions,
  listRulesOptions,
  listSyncsOptions,
  objectCountOptions,
} from "@pario/client/hooks"
import { Button, Card, EmptyState } from "@pario/ui/components"
import { cn } from "@pario/ui/lib/utils"
import { useQueries, useQuery } from "@tanstack/react-query"
import { Box, Loader2 } from "lucide-react"
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"
import {
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom"
import { ConnectorDetailPage, ConnectorsPage } from "./components/ConnectorsPage"
import { DatasetDetailPage, DatasetsPage } from "./components/DatasetsPage"
import { AppShell, Sidebar, type ViewMode } from "./components/layout"
import { ObjectDetailPage } from "./components/ObjectDetailPage"
import { ObjectsWorkbench, type ObjectTypePreviewSection } from "./components/ObjectsWorkbench"
import { ObjectTypeDetail } from "./components/ObjectTypeDetail"
import { OntologyExplorer } from "./components/OntologyExplorer"
import { PipelineDetailPage, PipelinesPage } from "./components/PipelinesPage"
import { RuleDetailPage, RulesPage } from "./components/RulesPage"
import { SettingsInvitationsPage } from "./components/SettingsInvitationsPage"
import { SyncDetailPage, SyncsPage } from "./components/SyncsPage"
import { type TelemetryUpdate, useWebSocket } from "./hooks/useWebSocket"
import {
  getObjectSortPreference,
  type ObjectSortPreference,
  setObjectSortPreference,
} from "./lib/userPreferences"

interface ProjectSidebarData {
  objectCount?: number
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
  "settings",
])
const emptyObjectList: ObjectSummary[] = []
const OBJECT_PAGE_SIZE = 300
const OBJECT_TYPE_PREVIEW_LIMIT = 12

function parseObjectOffset(value: string | null): number {
  if (!value) return 0

  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 0) return 0
  return parsed
}

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
    if (mode === "settings") {
      navigate("/settings/invitations")
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
      objectCount={sidebarData?.objectCount}
      connectorCount={sidebarData?.connectorCount}
      datasetCount={sidebarData?.datasetCount}
      syncCount={sidebarData?.syncCount}
      pipelineCount={sidebarData?.pipelineCount}
      ruleCount={sidebarData?.ruleCount}
      ontologyCount={sidebarData?.ontologyCount}
    />
  )

  return (
    <SidebarDataContext.Provider value={{ sidebarData, setSidebarData }}>
      <AppShell sidebar={sidebar} currentProjectName={selectedProject?.name ?? null}>
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
  const [objectSortBy, setObjectSortBy] = useState<ObjectSortPreference>(getObjectSortPreference)
  const [searchParams, setSearchParams] = useSearchParams()
  const classFilter = searchParams.get("class") || null
  const objectOffset = parseObjectOffset(searchParams.get("offset"))

  const setObjectOffset = useCallback(
    (nextOffset: number, options?: { replace?: boolean }) => {
      const offset = Math.max(0, Math.trunc(nextOffset))
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev)
          if (offset > 0) {
            params.set("offset", String(offset))
          } else {
            params.delete("offset")
          }
          return params
        },
        { replace: options?.replace ?? false }
      )
    },
    [setSearchParams]
  )

  const setClassFilter = useCallback(
    (next: string | null, options?: { offset?: number; replace?: boolean }) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev)
          if (next) {
            params.set("class", next)
          } else {
            params.delete("class")
          }
          const offset = Math.max(0, Math.trunc(options?.offset ?? 0))
          if (offset > 0) {
            params.set("offset", String(offset))
          } else {
            params.delete("offset")
          }
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

  useEffect(() => {
    if (!resolvedProjectName) return
    setLatestUpdates({})
  }, [resolvedProjectName])

  const objectsQuery = useQuery({
    ...listObjectsPageOptions({
      query: {
        objectTypeId: classFilter ?? undefined,
        limit: String(OBJECT_PAGE_SIZE),
        offset: objectOffset > 0 ? String(objectOffset) : undefined,
        orderBy: objectSortBy,
        order: objectSortBy === "primaryId" ? "asc" : "desc",
      },
    }),
    enabled: !!projectInfo && !!classFilter,
  })
  const objectsPage = objectsQuery.data
  const objects = objectsPage?.objects ?? emptyObjectList
  const { isLoading: objectsLoading } = objectsQuery

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

  useEffect(() => {
    const total = objectsPage?.total
    if (typeof total !== "number" || objectOffset === 0) return
    if (total === 0) {
      setObjectOffset(0, { replace: true })
      return
    }
    if (objectOffset < total) return

    const lastOffset = Math.floor((total - 1) / OBJECT_PAGE_SIZE) * OBJECT_PAGE_SIZE
    setObjectOffset(lastOffset, { replace: true })
  }, [objectOffset, objectsPage?.total, setObjectOffset])

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
      objectCount: globalObjectCountQuery.data ?? objectTypeTotal,
      datasetCount: datasets.length,
      connectorCount: connectors.length,
      syncCount: syncs.length,
      pipelineCount: pipelines.length,
      ruleCount: rules.length,
      ontologyCount: objectTypes.length,
      connected,
    })
  }, [
    globalObjectCountQuery.data,
    objectTypeTotal,
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
    () =>
      Object.fromEntries(
        [...objects, ...objectTypePreviewSections.flatMap((section) => section.objects)].map(
          (object) => [object.id, object]
        )
      ),
    [objects, objectTypePreviewSections]
  )

  const toProjectPath = (suffix: string) => `/${suffix}`

  const handleObjectSortByChange = (sortBy: ObjectSortPreference) => {
    setObjectSortBy(sortBy)
    setObjectSortPreference(sortBy)
    setObjectOffset(0, { replace: true })
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
                  objectsTotal={objectsPage?.total ?? objects.length}
                  objectsHasMore={objectsPage?.hasMore ?? false}
                  objectOffset={objectOffset}
                  objectPageSize={OBJECT_PAGE_SIZE}
                  allObjectsTotal={allObjectsTotal}
                  objectTypeCounts={objectTypeCounts}
                  overviewSections={objectTypePreviewSections}
                  overviewLoading={overviewLoading}
                  loading={objectsLoading}
                  sortBy={objectSortBy}
                  classFilter={classFilter}
                  selectedObjectId={selectedObjectIdForSidebar}
                  latestProjectUpdates={latestProjectUpdates}
                  onSortByChange={handleObjectSortByChange}
                  onClassFilterChange={(objectTypeId, offset) =>
                    setClassFilter(objectTypeId, { offset })
                  }
                  onObjectOffsetChange={setObjectOffset}
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
            <Route path="settings" element={<Navigate to="/settings/invitations" replace />} />
            <Route path="settings/invitations" element={<SettingsInvitationsPage />} />
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
