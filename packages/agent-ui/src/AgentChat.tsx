import {
  createAgentThreadMutation,
  getAgentThreadOptions,
  getAgentThreadQueryKey,
  listAgentsOptions,
  listAgentThreadMessagesOptions,
  listAgentThreadMessagesQueryKey,
  listAgentThreadsOptions,
  listAgentThreadsQueryKey,
  postAgentThreadMessageMutation,
} from "@sixb/client/hooks"
import { EmptyState } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { MessagesSquare } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { AgentsHome } from "./components/AgentsHome"
import { ConversationPanel } from "./components/ConversationPanel"
import { installAgentResizeObserverGuard } from "./resizeObserver"
import { useThreadStream } from "./useThreadStream"

interface PendingSend {
  readonly threadId: string
  readonly runId: string
}

interface PendingUser {
  readonly threadId: string
  readonly text: string
  messageId: string | null
}

export interface AgentChatProps {
  readonly threadId?: string | null
  readonly draftAgentId?: string | null
  readonly onNavigateHome: () => void
  readonly onNavigateDraft: (agentId: string) => void
  readonly onNavigateThread: (threadId: string) => void
  readonly className?: string
}

export function AgentChat({
  threadId: threadIdInput = null,
  draftAgentId: draftAgentIdInput = null,
  onNavigateHome,
  onNavigateDraft,
  onNavigateThread,
  className,
}: AgentChatProps) {
  const queryClient = useQueryClient()
  const threadId = threadIdInput ?? null
  const routeDraftAgentId = draftAgentIdInput ?? null

  // Coalesce ResizeObserver notifications app-wide (guards against benign loop errors). Idempotent,
  // so running it in a mount effect keeps the side effect out of module evaluation.
  useEffect(() => {
    installAgentResizeObserverGuard()
  }, [])

  // Durable catalog + thread list.
  const agentsQuery = useQuery(listAgentsOptions())
  const threadsQuery = useQuery(listAgentThreadsOptions({ query: { limit: "50", order: "desc" } }))
  const agents = useMemo(() => agentsQuery.data ?? [], [agentsQuery.data])
  const threads = threadsQuery.data?.threads ?? []
  const agentsById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents])
  const draftAgentId =
    threadId === null ? (routeDraftAgentId ?? (agents.length === 1 ? agents[0].id : null)) : null

  // Selected durable thread + its messages.
  const threadQuery = useQuery({
    ...getAgentThreadOptions({ path: { threadId: threadId ?? "" } }),
    enabled: threadId !== null,
  })
  const thread =
    threadId !== null
      ? (threadQuery.data ?? threads.find((candidate) => candidate.id === threadId) ?? null)
      : null

  const messagesQuery = useQuery({
    ...listAgentThreadMessagesOptions({
      path: { threadId: threadId ?? "" },
      query: { order: "asc" },
    }),
    enabled: threadId !== null,
  })
  const messages = useMemo(() => messagesQuery.data?.messages ?? [], [messagesQuery.data])

  // Live run bookkeeping.
  const [pendingSend, setPendingSend] = useState<PendingSend | null>(null)
  const [pendingUser, setPendingUser] = useState<PendingUser | null>(null)
  // A failed send to surface, scoped to the thread it belongs to (the just-created one when a new
  // chat's first message fails). English, user-facing.
  const [sendError, setSendError] = useState<{ threadId: string | null; message: string } | null>(
    null
  )
  // Text handed back to the composer after a failed send. The nonce makes the reseed fire even when
  // the same text is restored twice.
  const [draftReseed, setDraftReseed] = useState<{ text: string; nonce: number }>({
    text: "",
    nonce: 0,
  })

  const activeRunId =
    threadId !== null
      ? ((pendingSend?.threadId === threadId ? pendingSend.runId : null) ??
        thread?.activeRunId ??
        null)
      : null

  const { live, reconnecting } = useThreadStream({ threadId, runId: activeRunId })

  // Drop the pending run once it reaches any terminal status. `activeRunId` then falls back to the
  // durable `thread.activeRunId`, which stays set until its refetch lands — so the live row survives
  // the handoff to the stored message without flashing empty. Clearing on every terminal status (not
  // just a finalized success) means a run that ends without a persisted message — a tool-only turn,
  // or a lost finalize event — still clears instead of pinning the run and its socket forever.
  useEffect(() => {
    if (pendingSend && live.runId === pendingSend.runId && live.finishStatus !== null) {
      setPendingSend(null)
    }
  }, [pendingSend, live.runId, live.finishStatus])

  // Drop the optimistic user echo once the durable message lands (or the thread changes).
  useEffect(() => {
    if (!pendingUser) return
    if (pendingUser.threadId !== threadId) {
      setPendingUser(null)
      return
    }
    if (pendingUser.messageId && messages.some((message) => message.id === pendingUser.messageId)) {
      setPendingUser(null)
    }
  }, [pendingUser, threadId, messages])

  // Drop a stale send error when leaving its thread, but keep one that belongs to the thread we just
  // navigated to (a first message that failed on a freshly created thread).
  useEffect(() => {
    setSendError((current) => (current && current.threadId === threadId ? current : null))
  }, [threadId])

  const createThread = useMutation(createAgentThreadMutation())
  const postMessage = useMutation(postAgentThreadMessageMutation())

  const isRunning =
    activeRunId !== null && !(live.runId === activeRunId && live.finishStatus !== null)

  // Prefer the thread's own agent; fall back to the just-picked agent so a brand-new thread (not yet
  // in cache) keeps its identity instead of flashing a generic header while it loads.
  const currentAgent =
    (threadId !== null ? agentsById.get(thread?.agentId ?? "") : undefined) ??
    (draftAgentId ? agentsById.get(draftAgentId) : undefined)

  // Home (gallery + recent chats) only exists when there is more than one agent to choose between.
  const canGoHome = agents.length > 1

  // Other chats with the current agent, for the in-header history menu.
  const agentThreads = useMemo(
    () =>
      currentAgent
        ? threads
            .filter((entry) => entry.agentId === currentAgent.id && entry.id !== threadId)
            .slice(0, 8)
        : [],
    [threads, currentAgent, threadId]
  )

  // Start a fresh chat with a specific agent (from a home card or the header).
  const startNewChatWith = (agentId: string) => {
    onNavigateDraft(agentId)
  }

  // Return to the home/landing. With a single agent this lands back on its welcome screen.
  const goHome = () => {
    onNavigateHome()
  }

  const handleSend = async (text: string) => {
    if (isRunning) return
    setSendError(null)
    const targetThreadId = threadId
    // Set only if we create a thread before failing, so the retry lands in the right place.
    let createdThreadId: string | null = null
    try {
      if (targetThreadId !== null) {
        setPendingUser({ threadId: targetThreadId, text, messageId: null })
        const response = await postMessage.mutateAsync({
          path: { threadId: targetThreadId },
          body: { text },
        })
        setPendingSend({ threadId: response.threadId, runId: response.runId })
        setPendingUser((current) =>
          current && current.threadId === response.threadId
            ? { ...current, messageId: response.triggerMessageId }
            : current
        )
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: listAgentThreadMessagesQueryKey({ path: { threadId: targetThreadId } }),
          }),
          queryClient.invalidateQueries({ queryKey: listAgentThreadsQueryKey() }),
        ])
        return
      }

      const agentId = draftAgentId
      if (!agentId) return
      const created = await createThread.mutateAsync({
        body: { agentId, title: deriveTitle(text) },
      })
      createdThreadId = created.thread.id
      const newThreadId = created.thread.id
      setPendingUser({ threadId: newThreadId, text, messageId: null })
      const response = await postMessage.mutateAsync({
        path: { threadId: newThreadId },
        body: { text },
      })
      setPendingSend({ threadId: newThreadId, runId: response.runId })
      setPendingUser((current) =>
        current && current.threadId === newThreadId
          ? { ...current, messageId: response.triggerMessageId }
          : current
      )
      await queryClient.invalidateQueries({ queryKey: listAgentThreadsQueryKey() })
      onNavigateThread(newThreadId)
    } catch {
      // The send failed (e.g. 409 active_run_exists, or the network dropped). Drop the optimistic
      // echo, hand the text back to the composer so nothing is lost, and surface the failure. If a
      // thread was created before the failure, move to it so the retry (and error) land there.
      setPendingUser(null)
      setDraftReseed((current) => ({ text, nonce: current.nonce + 1 }))
      setSendError({
        threadId: createdThreadId ?? targetThreadId,
        message: "Couldn't send your message. Please try again.",
      })
      if (createdThreadId) onNavigateThread(createdThreadId)
      if (targetThreadId !== null) {
        void queryClient.invalidateQueries({
          queryKey: getAgentThreadQueryKey({ path: { threadId: targetThreadId } }),
        })
      }
      void queryClient.invalidateQueries({ queryKey: listAgentThreadsQueryKey() })
    }
  }

  if (agentsQuery.isLoading) {
    return <LoadingState className={className} label="Loading agents..." />
  }
  if (agentsQuery.isError) {
    return (
      <ErrorState
        className={className}
        title="Agents unavailable"
        description="Could not load registered agents."
      />
    )
  }
  if (agents.length === 0) {
    return (
      <div className={cn("flex h-full items-center justify-center p-6", className)}>
        <EmptyState
          icon={<MessagesSquare className="size-12 stroke-1" />}
          title="No agents registered"
          description="Agents are discovered from your project's agents/ directory. Define one to start a chat."
        />
      </div>
    )
  }

  const home = threadId === null && draftAgentId === null
  const pendingUserText =
    pendingUser &&
    pendingUser.threadId === threadId &&
    !(pendingUser.messageId && messages.some((message) => message.id === pendingUser.messageId))
      ? pendingUser.text
      : null

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      {home ? (
        <AgentsHome
          agents={agents}
          threads={threads}
          agentsById={agentsById}
          threadsError={threadsQuery.isError ? "Could not load chats." : null}
          onPickAgent={startNewChatWith}
          onSelectThread={onNavigateThread}
        />
      ) : (
        <ConversationPanel
          agent={currentAgent}
          messages={messages}
          live={live}
          messagesLoading={threadId !== null && messagesQuery.isLoading}
          messagesError={
            threadId !== null && messagesQuery.isError ? "Could not load this conversation." : null
          }
          streaming={live.active && live.runId === activeRunId}
          pendingUserText={pendingUserText}
          awaitingResponse={isRunning}
          reconnecting={reconnecting}
          sendError={sendError && sendError.threadId === threadId ? sendError.message : null}
          agents={agents}
          agentThreads={agentThreads}
          canGoHome={canGoHome}
          onSend={handleSend}
          onBackHome={goHome}
          onNewChat={() => {
            if (currentAgent) startNewChatWith(currentAgent.id)
          }}
          onPickAgent={startNewChatWith}
          onSelectThread={onNavigateThread}
          composerDisabled={isRunning}
          composerPending={postMessage.isPending || createThread.isPending}
          composerPlaceholder={
            currentAgent ? `Message ${currentAgent.name}...` : "Send a message..."
          }
          composerDraft={draftReseed.text}
          composerDraftNonce={draftReseed.nonce}
        />
      )}
    </div>
  )
}

function LoadingState({ label, className }: { label: string; className?: string }) {
  return (
    <div className={cn("flex h-full items-center justify-center", className)}>
      <p className="text-sm text-muted-foreground">{label}</p>
    </div>
  )
}

function ErrorState({
  title,
  description,
  className,
}: {
  title: string
  description: string
  className?: string
}) {
  return (
    <div className={cn("flex h-full items-center justify-center p-6 text-center", className)}>
      <div className="max-w-md space-y-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}

function deriveTitle(text: string): string {
  const firstLine = text.split("\n")[0]?.trim() ?? ""
  if (firstLine.length <= 60) return firstLine
  return `${firstLine.slice(0, 57)}...`
}
