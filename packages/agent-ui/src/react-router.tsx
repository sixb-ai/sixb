import { cn } from "@sixb/ui/lib/utils"
import { useCallback } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { AgentChat, type AgentChatProps } from "./AgentChat"

export interface AgentChatPageProps
  extends Omit<
    AgentChatProps,
    "threadId" | "draftAgentId" | "onNavigateHome" | "onNavigateDraft" | "onNavigateThread"
  > {
  readonly routeBase?: string
  /** Destination outside the standalone Agents workspace. */
  readonly backTo?: string
  readonly backLabel?: string
}

export function AgentChatPage({
  routeBase = "/agents",
  backTo = "/",
  backLabel = "Back to app",
  className,
  ...props
}: AgentChatPageProps) {
  const navigate = useNavigate()
  const { agentId: routeAgentId, threadId: routeThreadId } = useParams()
  const normalizedRouteBase = normalizeRouteBase(routeBase)

  const onExit = useCallback(() => {
    navigate(backTo)
  }, [backTo, navigate])

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
    <section className="fixed inset-0 z-50 flex h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <AgentChat
        {...props}
        threadId={routeThreadId ?? null}
        draftAgentId={routeAgentId ?? null}
        onNavigateHome={onNavigateHome}
        onNavigateDraft={onNavigateDraft}
        onNavigateThread={onNavigateThread}
        onExit={onExit}
        exitLabel={backLabel}
        className={cn("min-h-0 flex-1", className)}
      />
    </section>
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
