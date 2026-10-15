import { lazy } from "react"
import type { ViewMode } from "../components/layout/Sidebar"
import { KNOWN_VIEWS } from "../components/layout/viewMode"

const loadActionsPage = () => import("./ActionsPage")
const loadObjectDetailPage = () => import("./ObjectDetailPage")
const loadObjectTypeDetailPage = () => import("./ObjectTypeDetail")
const loadOntologyExplorer = () => import("./OntologyExplorer")
const loadRulesPage = () => import("./RulesPage")
const loadWorkflowDetailPage = () => import("./WorkflowDetailPage")
const loadWorkflowsPage = () => import("./WorkflowsPage")

export const ActionsPage = lazy(() =>
  loadActionsPage().then((module) => ({ default: module.ActionsPage }))
)
export const ObjectDetailPage = lazy(() =>
  loadObjectDetailPage().then((module) => ({ default: module.ObjectDetailPage }))
)
export const ObjectTypeDetail = lazy(() =>
  loadObjectTypeDetailPage().then((module) => ({ default: module.ObjectTypeDetail }))
)
export const OntologyExplorer = lazy(() =>
  loadOntologyExplorer().then((module) => ({ default: module.OntologyExplorer }))
)
export const RuleDetailPage = lazy(() =>
  loadRulesPage().then((module) => ({ default: module.RuleDetailPage }))
)
export const RulesPage = lazy(() =>
  loadRulesPage().then((module) => ({ default: module.RulesPage }))
)
export const WorkflowDetailPage = lazy(() =>
  loadWorkflowDetailPage().then((module) => ({ default: module.WorkflowDetailPage }))
)
export const WorkflowsPage = lazy(() =>
  loadWorkflowsPage().then((module) => ({ default: module.WorkflowsPage }))
)

type WorkspaceRouteLoader = () => Promise<unknown>

const workspaceViewLoaders: Partial<Record<ViewMode, WorkspaceRouteLoader>> = {
  actions: loadActionsPage,
  ontology: loadOntologyExplorer,
  rules: loadRulesPage,
  workflows: loadWorkflowsPage,
}

export function preloadWorkspaceView(view: ViewMode): void {
  preload(workspaceViewLoaders[view])
}

export function preloadWorkspacePath(pathname: string): void {
  const [view, detail] = pathname.split("/").filter(Boolean)

  if (!view || view === "home" || view === "objects") return

  if (view === "workflows" && detail) {
    preload(loadWorkflowDetailPage)
    return
  }
  if (view === "ontology" && detail) {
    preload(loadObjectTypeDetailPage)
    return
  }

  if (KNOWN_VIEWS.has(view)) {
    preload(workspaceViewLoaders[view as ViewMode])
    return
  }

  preload(loadObjectDetailPage)
}

function preload(loader: WorkspaceRouteLoader | undefined): void {
  // Preloading is opportunistic. If it fails, React.lazy owns the visible route error path.
  void loader?.().catch(() => undefined)
}
