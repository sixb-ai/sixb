import { Button } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { ArrowLeft } from "lucide-react"
import { useCallback } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { AgentChat, type AgentChatProps } from "./AgentChat"
import { useRegisteredAgentContext } from "./AgentContextProvider"

export type {
  AgentDocumentPreviewRenderer,
  AgentDocumentPreviewRendererProps,
} from "./document-preview/types"
export type { AgentFileRef } from "./types"

export interface AgentChatPageProps
  extends Omit<AgentChatProps, "threadId" | "onNavigateHome" | "onNavigateThread"> {
  readonly routeBase?: string
}

export function AgentChatPage({
  routeBase = "/agents",
  className,
  ambientContext,
  conversationHeaderActions,
  ...props
}: AgentChatPageProps) {
  const navigate = useNavigate()
  const registeredContext = useRegisteredAgentContext()
  const { threadId: routeThreadId } = useParams()
  const normalizedRouteBase = normalizeRouteBase(routeBase)

  const onNavigateHome = useCallback(() => {
    navigate(normalizedRouteBase)
  }, [navigate, normalizedRouteBase])

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
        ambientContext={ambientContext ?? registeredContext}
        threadId={routeThreadId ?? null}
        onNavigateHome={onNavigateHome}
        onNavigateThread={onNavigateThread}
        conversationHeaderActions={
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              aria-label="Back to app"
              title="Back to app"
              onClick={() => navigate("/")}
            >
              <ArrowLeft />
            </Button>
            {conversationHeaderActions}
          </>
        }
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
