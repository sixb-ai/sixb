import { getProjectInfoOptions } from "@sixb/client/hooks"
import { Toaster } from "@sixb/ui/components"
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { Outlet, useLocation, useNavigate } from "react-router-dom"
import { preloadWorkspaceView } from "../../pages/workspaceRoutes"
import { AppShell } from "./AppShell"
import { Sidebar, type ViewMode } from "./Sidebar"
import { type ProjectSidebarData, SidebarDataContext } from "./sidebarData"
import { getViewModeFromPath } from "./viewMode"
import { WorkspaceCommandMenu } from "./WorkspaceCommandMenu"

export function AppLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const [sidebarData, setSidebarData] = useState<ProjectSidebarData | null>(null)
  const [commandMenuOpen, setCommandMenuOpen] = useState(false)

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
      navigate("/settings/members")
      return
    }
    navigate(`/${mode}`)
  }

  const sidebar = (
    <Sidebar
      selectedProject={selectedProject}
      viewMode={viewMode}
      onViewChange={handleViewChange}
      onViewIntent={preloadWorkspaceView}
      onOpenCommand={() => setCommandMenuOpen(true)}
      objectCount={sidebarData?.objectCount}
      workflowCount={sidebarData?.workflowCount}
      actionCount={sidebarData?.actionCount}
    />
  )

  return (
    <SidebarDataContext.Provider value={{ sidebarData, setSidebarData }}>
      <AppShell sidebar={sidebar} currentProjectName={selectedProject?.name ?? null}>
        <Outlet />
      </AppShell>
      <WorkspaceCommandMenu open={commandMenuOpen} onOpenChange={setCommandMenuOpen} />
      <Toaster position="bottom-right" />
    </SidebarDataContext.Provider>
  )
}
