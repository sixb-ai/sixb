import { useCallback } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { AgentChat, type AgentChatProps } from "./AgentChat"

export interface AgentChatPageProps
  extends Omit<
    AgentChatProps,
    "threadId" | "draftAgentId" | "onNavigateHome" | "onNavigateDraft" | "onNavigateThread"
  > {
  readonly routeBase?: string
}

export function AgentChatPage({ routeBase = "/agents", ...props }: AgentChatPageProps) {
  const navigate = useNavigate()
  const { agentId: routeAgentId, threadId: routeThreadId } = useParams()
  const normalizedRouteBase = normalizeRouteBase(routeBase)

  const onNavigateHome = useCallback(() => {
    navigate(normalizedRouteBase)
  }, [navigate, normalizedRouteBase])

  const onNavigateDraft = useCallback(
    (agentId: string) => {
      navigate(draftPath(normalizedRouteBase, agentId))
    },
    [navigate, normalizedRouteBase]
  )

  const onNavigateThread = useCallback(
    (threadId: string) => {
      navigate(threadPath(normalizedRouteBase, threadId))
    },
    [navigate, normalizedRouteBase]
  )

  return (
    <AgentChat
      {...props}
      threadId={routeThreadId ?? null}
      draftAgentId={routeAgentId ?? null}
      onNavigateHome={onNavigateHome}
      onNavigateDraft={onNavigateDraft}
      onNavigateThread={onNavigateThread}
    />
  )
}

function normalizeRouteBase(routeBase: string): string {
  const trimmed = routeBase.trim()
  if (!trimmed || trimmed === "/") return "/"
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`
  return withLeadingSlash.replace(/\/+$/, "") || "/"
}

function threadPath(routeBase: string, threadId: string): string {
  const encoded = encodeURIComponent(threadId)
  return routeBase === "/" ? `/${encoded}` : `${routeBase}/${encoded}`
}

function draftPath(routeBase: string, agentId: string): string {
  const encoded = encodeURIComponent(agentId)
  return routeBase === "/" ? `/new/${encoded}` : `${routeBase}/new/${encoded}`
}
