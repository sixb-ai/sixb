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
import { useAgentMessages } from "./i18n"

export type { AgentFileRef } from "./types"

export interface AgentChatPageProps
  extends Omit<
    AgentChatProps,
    "threadId" | "onNavigateHome" | "onNavigateThread" | "artifactTarget" | "onArtifactTargetChange"
  > {
  readonly routeBase?: string
}

export function AgentChatPage({
  routeBase = "/agents",
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

function threadPath(routeBase: string, threadId: string): string {
  const encoded = encodeURIComponent(threadId)
  return routeBase === "/" ? `/${encoded}` : `${routeBase}/${encoded}`
}
