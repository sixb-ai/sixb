import {
  getProjectInfoOptions,
  listWorkflowRunsOptions,
  listWorkflowsOptions,
} from "@pario/client/hooks"
import { useQuery } from "@tanstack/react-query"
import { Outlet, useLocation, useNavigate } from "react-router-dom"
import { AppShell } from "./AppShell"
import { Sidebar, type ViewMode } from "./Sidebar"

export function AppLayout() {
  const navigate = useNavigate()
  const location = useLocation()

  const projectQuery = useQuery({
    ...getProjectInfoOptions(),
    retry: false,
  })
  const workflowsQuery = useQuery({
    ...listWorkflowsOptions(),
    enabled: projectQuery.isSuccess,
  })
  const runsQuery = useQuery({
    ...listWorkflowRunsOptions({ query: { limit: "1", order: "desc" } }),
    enabled: projectQuery.isSuccess,
  })

  const selectedProject = projectQuery.data ? { name: projectQuery.data.id } : null
  const viewMode = getViewModeFromPath(location.pathname)
  const sidebar = (
    <Sidebar
      selectedProject={selectedProject}
      viewMode={viewMode}
      onViewChange={(mode) => navigate(mode === "workflows" ? "/" : "/runs")}
      workflowCount={workflowsQuery.data?.length}
      runCount={runsQuery.data?.total}
    />
  )

  return (
    <AppShell sidebar={sidebar} currentProjectName={selectedProject?.name ?? null}>
      <Outlet />
    </AppShell>
  )
}

function getViewModeFromPath(pathname: string): ViewMode {
  return pathname === "/runs" || pathname.startsWith("/runs/") ? "runs" : "workflows"
}
