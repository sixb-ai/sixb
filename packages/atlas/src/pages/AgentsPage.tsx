import { AgentChatPage } from "@sixb/agent-ui/react-router"
import { getProjectInfoOptions } from "@sixb/client/hooks"
import { useQuery } from "@tanstack/react-query"
import { AtlasSidebarFooter, AtlasSidebarHeader } from "../components/layout/Sidebar"

export function AgentsPage() {
  const { data: projectInfo } = useQuery({
    ...getProjectInfoOptions(),
    retry: false,
  })
  const selectedProject = projectInfo ? { name: projectInfo.id } : null

  return (
    <AgentChatPage
      routeBase="/agents"
      sidebarHeader={<AtlasSidebarHeader selectedProject={selectedProject} />}
      sidebarFooter={<AtlasSidebarFooter />}
      sidebarWidth="16rem"
    />
  )
}
