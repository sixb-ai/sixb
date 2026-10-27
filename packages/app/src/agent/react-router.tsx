import { Button } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { ArrowLeft } from "lucide-react"
import { useCallback, useMemo } from "react"
import { useNavigate, useParams, useSearchParams } from "react-router-dom"
import {
  type ArtifactTarget,
  artifactTargetFromSearch,
  withArtifactTarget,
} from "../artifacts/target"
import { AgentChat, type AgentChatProps } from "./agent-chat"
import { useRegisteredAgentContext } from "./agent-context-provider"
import { AgentThreads } from "./components/agent-threads"
import { useAgentMessages } from "./i18n"
import { THREADS_PATH, threadPath } from "./thread-navigation"

export type { AgentFileRef } from "./types"

export interface AgentChatPageProps
  extends Omit<
    AgentChatProps,
    "threadId" | "onNavigateHome" | "onNavigateThread" | "artifactTarget" | "onArtifactTargetChange"
  > {
  readonly routeBase?: string
}

/**
 * One conversation on a page of its own, at `${routeBase}/:threadId`. A new conversation starts at
 * the app's home, and the page of every conversation is `routeBase` itself.
 */
export function AgentChatPage({
  routeBase = THREADS_PATH,
  className,
  ambientContext,
  conversationHeaderActions,
  ...props
}: AgentChatPageProps) {
  const messages = useAgentMessages().surface
  const navigate = useNavigate()
  const registeredContext = useRegisteredAgentContext()
  const { threadId: routeThreadId } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const normalizedRouteBase = normalizeRouteBase(routeBase)
  // The open artifact lives in `?artifact=&v=&part=`, so a reload or a shared link lands on it.
  const searchKey = searchParams.toString()
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key stands for the parameters.
  const artifactTarget = useMemo(() => artifactTargetFromSearch(searchParams), [searchKey])
  const onArtifactTargetChange = useCallback(
    (target: ArtifactTarget | null) => {
      setSearchParams((current) => withArtifactTarget(current, target), {
        replace: target === null,
      })
    },
    [setSearchParams]
  )

  const onNavigateHome = useCallback(() => {
    navigate("/")
  }, [navigate])

  const onNavigateThread = useCallback(
    (threadId: string) => {
      navigate(threadPathUnder(normalizedRouteBase, threadId))
    },
    [navigate, normalizedRouteBase]
  )

  const onOpenThreads = useCallback(() => {
    navigate(normalizedRouteBase)
  }, [navigate, normalizedRouteBase])

  return (
    <section className="fixed inset-0 z-50 flex h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <AgentChat
        {...props}
        ambientContext={ambientContext ?? registeredContext}
        threadId={routeThreadId ?? null}
        onNavigateHome={onNavigateHome}
        onNavigateThread={onNavigateThread}
        onOpenThreads={onOpenThreads}
        artifactTarget={artifactTarget}
        onArtifactTargetChange={onArtifactTargetChange}
        conversationHeaderActions={
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              aria-label={messages.backToApp}
              title={messages.backToApp}
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

/**
 * Every conversation, on a page of its own beside the chat: search them, open one, or start
 * another.
 */
export function AgentThreadsPage() {
  const messages = useAgentMessages().surface
  const navigate = useNavigate()

  return (
    <section className="fixed inset-0 z-50 flex h-dvh min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <AgentThreads
        className="min-h-0 flex-1"
        onSelectThread={(threadId) => navigate(threadPath(threadId))}
        onNewThread={() => navigate("/")}
        headerActions={
          <Button
            type="button"
            variant="ghost"
            size="icon-lg"
            aria-label={messages.backToApp}
            title={messages.backToApp}
            onClick={() => navigate("/")}
            className="-ml-2"
          >
            <ArrowLeft />
          </Button>
        }
      />
    </section>
  )
}

function threadPathUnder(routeBase: string, threadId: string): string {
  const encoded = encodeURIComponent(threadId)
  return routeBase === "/" ? `/${encoded}` : `${routeBase}/${encoded}`
}
