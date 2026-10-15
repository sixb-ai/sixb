import { getAgentOptions } from "@sixb/client/hooks"
import { useQuery } from "@tanstack/react-query"
import { lazy, Suspense } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { useAppMessages } from "../locale"
import { useSectionsEnabled } from "../sections/sections"

// The agent's UI loads only in a project that has an agent.
const AgentSurface = lazy(() =>
  import("@sixb/agent-ui").then((module) => ({ default: module.AgentSurface }))
)

/**
 * The project's agent beside every page, collapsed until opened. It stays out of Home and the
 * agent's own pages, which are conversations already, out of shared links, and out of a project
 * with no agent.
 */
export function AgentDock() {
  const messages = useAppMessages().agent
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const enabled = useSectionsEnabled()
  const agent = useQuery({ ...getAgentOptions(), enabled, retry: false, staleTime: 5 * 60_000 })
  const conversationPage =
    pathname === "/" || pathname === "/agents" || pathname.startsWith("/agents/")
  if (!enabled || !agent.data || conversationPage) return null

  return (
    <Suspense fallback={null}>
      <AgentSurface
        title={messages.title}
        launcherLabel={messages.open}
        defaultMode="collapsed"
        onExpandThread={(threadId) => navigate(`/agents/${encodeURIComponent(threadId)}`)}
        persistenceKey="sixb.app.agent-dock.v1"
      />
    </Suspense>
  )
}
