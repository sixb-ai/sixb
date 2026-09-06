import { AgentSurface } from "@sixb/agent-ui"
import { getProjectInfoOptions } from "@sixb/client/hooks"
import { Toaster } from "@sixb/ui/components"
import { useQuery } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import { Outlet, useLocation, useNavigate } from "react-router-dom"
import { ATLAS_AGENT_SURFACE_KEY } from "../../lib/agentSurface"
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
  const agentsPage = location.pathname === "/agents" || location.pathname === "/agents/"
  const currentLocation = `${location.pathname}${location.search}${location.hash}`
  const lastWorkspaceLocation = useRef(agentsPage ? "/" : currentLocation)

  useEffect(() => {
    if (!agentsPage) lastWorkspaceLocation.current = currentLocation
  }, [agentsPage, currentLocation])

  const { data: projectInfo } = useQuery({
    ...getProjectInfoOptions(),
    retry: false,
  })

  const selectedProject = projectInfo ? { name: projectInfo.id } : null
  const viewMode = getViewModeFromPath(location.pathname)
  const handleViewChange = (mode: ViewMode) => {
    if (mode === "agents") {
      navigate("/agents")
      return
    }
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
        <div className="relative flex h-full min-h-0">
          <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
            <Outlet />
          </div>
          <AgentSurface
            title="Agents"
            launcherLabel="Open agents"
            defaultMode="collapsed"
            fullPage={agentsPage}
            onRequestFullPage={() => navigate("/agents")}
            onRequestDock={() => navigate(lastWorkspaceLocation.current, { replace: true })}
            persistenceKey={ATLAS_AGENT_SURFACE_KEY}
          />
        </div>
      </AppShell>
      <WorkspaceCommandMenu open={commandMenuOpen} onOpenChange={setCommandMenuOpen} />
      <Toaster position="bottom-right" />
    </SidebarDataContext.Provider>
  )
}
