import { getProjectInfoOptions } from "@sixb/client/hooks"
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { Outlet, useLocation, useNavigate } from "react-router-dom"
import { AppShell } from "./AppShell"
import { Sidebar, type ViewMode } from "./Sidebar"
import { type ProjectSidebarData, SidebarDataContext } from "./sidebarData"
import { getViewModeFromPath } from "./viewMode"

export function AppLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const [sidebarData, setSidebarData] = useState<ProjectSidebarData | null>(null)

  const { data: projectInfo } = useQuery({
    ...getProjectInfoOptions(),
    retry: false,
  })

  const selectedProject = projectInfo ? { name: projectInfo.id } : null
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
      viewMode={viewMode}
      onViewChange={handleViewChange}
      objectCount={sidebarData?.objectCount}
      connectorCount={sidebarData?.connectorCount}
      datasetCount={sidebarData?.datasetCount}
      syncCount={sidebarData?.syncCount}
      pipelineCount={sidebarData?.pipelineCount}
      projectionCount={sidebarData?.projectionCount}
      workflowCount={sidebarData?.workflowCount}
      actionCount={sidebarData?.actionCount}
      agentCount={sidebarData?.agentCount}
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
