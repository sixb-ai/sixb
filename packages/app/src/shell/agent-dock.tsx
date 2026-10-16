import { getAgentOptions } from "@sixb/client/hooks"
import { useQuery } from "@tanstack/react-query"
import { useLocation, useNavigate } from "react-router-dom"
import { AgentSurface } from "../agent/agent-surface"
import { useAppMessages } from "../locale"
import { useSectionsEnabled } from "../sections/sections"

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
    <AgentSurface
      title={messages.title}
      launcherLabel={messages.open}
      defaultMode="collapsed"
      onExpandThread={(threadId) => navigate(`/agents/${encodeURIComponent(threadId)}`)}
      persistenceKey="sixb.app.agent-dock.v1"
    />
  )
}
