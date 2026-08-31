import { lazy } from "react"
import type { ViewMode } from "../components/layout/Sidebar"
import { KNOWN_VIEWS } from "../components/layout/viewMode"

const loadActionRunDetailPage = () => import("./ActionRunDetailPage")
const loadActionsPage = () => import("./ActionsPage")
const loadAgentsPage = () => import("./AgentsPage")
const loadAiUsagePage = () => import("./AiUsagePage")
const loadConnectorsPage = () => import("./ConnectorsPage")
const loadDatasetsPage = () => import("./DatasetsPage")
const loadLogsPage = () => import("./LogsPage")
const loadObjectDetailPage = () => import("./ObjectDetailPage")
const loadObjectTypeDetailPage = () => import("./ObjectTypeDetail")
const loadOntologyExplorer = () => import("./OntologyExplorer")
const loadPipelinesPage = () => import("./PipelinesPage")
const loadProjectionsPage = () => import("./ProjectionsPage")
const loadRulesPage = () => import("./RulesPage")
const loadSyncsPage = () => import("./SyncsPage")
const loadWorkflowDetailPage = () => import("./WorkflowDetailPage")
const loadWorkflowsPage = () => import("./WorkflowsPage")
const loadSettingsMembersPage = () => import("../components/SettingsMembersPage")
const loadSettingsServiceAccountsPage = () => import("../components/SettingsServiceAccountsPage")
const loadSettingsSessionsPage = () => import("../components/SettingsSessionsPage")
const loadSettingsTokensPage = () => import("../components/SettingsTokensPage")

export const ActionRunDetailPage = lazy(() =>
  loadActionRunDetailPage().then((module) => ({ default: module.ActionRunDetailPage }))
)
export const ActionsPage = lazy(() =>
  loadActionsPage().then((module) => ({ default: module.ActionsPage }))
)
export const AgentsPage = lazy(() =>
  loadAgentsPage().then((module) => ({ default: module.AgentsPage }))
)
export const AiUsagePage = lazy(() =>
  loadAiUsagePage().then((module) => ({ default: module.AiUsagePage }))
)
export const ConnectorDetailPage = lazy(() =>
  loadConnectorsPage().then((module) => ({ default: module.ConnectorDetailPage }))
)
export const ConnectorsPage = lazy(() =>
  loadConnectorsPage().then((module) => ({ default: module.ConnectorsPage }))
)
export const DatasetDetailPage = lazy(() =>
  loadDatasetsPage().then((module) => ({ default: module.DatasetDetailPage }))
)
export const DatasetsPage = lazy(() =>
  loadDatasetsPage().then((module) => ({ default: module.DatasetsPage }))
)
export const LogsPage = lazy(() => loadLogsPage().then((module) => ({ default: module.LogsPage })))
export const ObjectDetailPage = lazy(() =>
  loadObjectDetailPage().then((module) => ({ default: module.ObjectDetailPage }))
)
export const ObjectTypeDetail = lazy(() =>
  loadObjectTypeDetailPage().then((module) => ({ default: module.ObjectTypeDetail }))
)
export const OntologyExplorer = lazy(() =>
  loadOntologyExplorer().then((module) => ({ default: module.OntologyExplorer }))
)
export const PipelineDetailPage = lazy(() =>
  loadPipelinesPage().then((module) => ({ default: module.PipelineDetailPage }))
)
export const PipelinesPage = lazy(() =>
  loadPipelinesPage().then((module) => ({ default: module.PipelinesPage }))
)
export const ProjectionDetailPage = lazy(() =>
  loadProjectionsPage().then((module) => ({ default: module.ProjectionDetailPage }))
)
export const ProjectionsPage = lazy(() =>
  loadProjectionsPage().then((module) => ({ default: module.ProjectionsPage }))
)
export const RuleDetailPage = lazy(() =>
  loadRulesPage().then((module) => ({ default: module.RuleDetailPage }))
)
export const RulesPage = lazy(() =>
  loadRulesPage().then((module) => ({ default: module.RulesPage }))
)
export const SyncDetailPage = lazy(() =>
  loadSyncsPage().then((module) => ({ default: module.SyncDetailPage }))
)
export const SyncsPage = lazy(() =>
  loadSyncsPage().then((module) => ({ default: module.SyncsPage }))
)
export const WorkflowDetailPage = lazy(() =>
  loadWorkflowDetailPage().then((module) => ({ default: module.WorkflowDetailPage }))
)
export const WorkflowsPage = lazy(() =>
  loadWorkflowsPage().then((module) => ({ default: module.WorkflowsPage }))
)
export const SettingsMembersPage = lazy(() =>
  loadSettingsMembersPage().then((module) => ({ default: module.SettingsMembersPage }))
)
export const SettingsServiceAccountsPage = lazy(() =>
  loadSettingsServiceAccountsPage().then((module) => ({
    default: module.SettingsServiceAccountsPage,
  }))
)
export const SettingsSessionsPage = lazy(() =>
  loadSettingsSessionsPage().then((module) => ({ default: module.SettingsSessionsPage }))
)
export const SettingsTokensPage = lazy(() =>
  loadSettingsTokensPage().then((module) => ({ default: module.SettingsTokensPage }))
)

type WorkspaceRouteLoader = () => Promise<unknown>

const workspaceViewLoaders: Partial<Record<ViewMode, WorkspaceRouteLoader>> = {
  actions: loadActionsPage,
  agents: loadAgentsPage,
  "ai-usage": loadAiUsagePage,
  connectors: loadConnectorsPage,
  datasets: loadDatasetsPage,
  logs: loadLogsPage,
  ontology: loadOntologyExplorer,
  pipelines: loadPipelinesPage,
  projections: loadProjectionsPage,
  rules: loadRulesPage,
  settings: loadSettingsMembersPage,
  syncs: loadSyncsPage,
  workflows: loadWorkflowsPage,
}

export function preloadWorkspaceView(view: ViewMode): void {
  preload(workspaceViewLoaders[view])
}

export function preloadWorkspacePath(pathname: string): void {
  const [view, detail, id] = pathname.split("/").filter(Boolean)

  if (!view || view === "home" || view === "objects") return

  if (view === "actions" && detail === "runs" && id) {
    preload(loadActionRunDetailPage)
    return
  }
  if (view === "workflows" && detail) {
    preload(loadWorkflowDetailPage)
    return
  }
  if (view === "runs") {
    preload(loadWorkflowDetailPage)
    return
  }
  if (view === "ontology" && detail) {
    preload(loadObjectTypeDetailPage)
    return
  }
  if (view === "settings") {
    preload(settingsLoader(detail))
    return
  }

  if (KNOWN_VIEWS.has(view)) {
    preload(workspaceViewLoaders[view as ViewMode])
    return
  }

  preload(loadObjectDetailPage)
}

function settingsLoader(section: string | undefined): WorkspaceRouteLoader {
  if (section === "tokens") return loadSettingsTokensPage
  if (section === "service-accounts") return loadSettingsServiceAccountsPage
  if (section === "sessions") return loadSettingsSessionsPage
  return loadSettingsMembersPage
}

function preload(loader: WorkspaceRouteLoader | undefined): void {
  // Preloading is opportunistic. If it fails, React.lazy owns the visible route error path.
  void loader?.().catch(() => undefined)
}
