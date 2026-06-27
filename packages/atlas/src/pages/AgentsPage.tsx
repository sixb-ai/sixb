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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { MessagesSquare } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { ErrorPage, LoadingPage } from "../components/common"
import { AgentsHome } from "../features/agents/components/AgentsHome"
import { ConversationPanel } from "../features/agents/components/ConversationPanel"
import { useThreadStream } from "../features/agents/useThreadStream"

interface PendingSend {
  readonly threadId: string
  readonly runId: string
}

interface PendingUser {
  readonly threadId: string
  readonly text: string
  messageId: string | null
}

export function AgentsPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { threadId: routeThreadId } = useParams()
  const threadId = routeThreadId ?? null

  // Durable catalog + thread list.
  const agentsQuery = useQuery(listAgentsOptions())
  const threadsQuery = useQuery(listAgentThreadsOptions({ query: { limit: "50", order: "desc" } }))
  const agents = useMemo(() => agentsQuery.data ?? [], [agentsQuery.data])
  const threads = threadsQuery.data?.threads ?? []
  const agentsById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents])

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

  // Agent picked for a brand-new chat. With a single agent we default to it (skip the gallery);
  // with several we leave it unset so the landing shows the explore gallery.
  const [composingAgentId, setComposingAgentId] = useState<string | null>(null)
  useEffect(() => {
    if (threadId === null && composingAgentId === null && agents.length === 1) {
      setComposingAgentId(agents[0].id)
    }
  }, [threadId, composingAgentId, agents])

  // Live run bookkeeping.
  const [pendingSend, setPendingSend] = useState<PendingSend | null>(null)
  const [pendingUser, setPendingUser] = useState<PendingUser | null>(null)

  const activeRunId =
    threadId !== null
      ? ((pendingSend?.threadId === threadId ? pendingSend.runId : null) ??
        thread?.activeRunId ??
        null)
      : null

  const { live } = useThreadStream({ threadId, runId: activeRunId })

  // Drop the pending run once the finalized assistant message is in durable state.
  useEffect(() => {
    if (!pendingSend || live.runId !== pendingSend.runId || !live.finishStatus) return
    if (
      live.finishStatus === "succeeded" &&
      live.finalizedMessageId &&
      messages.some((message) => message.id === live.finalizedMessageId)
    ) {
      setPendingSend(null)
    }
  }, [pendingSend, live.runId, live.finishStatus, live.finalizedMessageId, messages])

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

  const createThread = useMutation(createAgentThreadMutation())
  const postMessage = useMutation(postAgentThreadMessageMutation())

  const isRunning =
    activeRunId !== null && !(live.runId === activeRunId && live.finishStatus !== null)

  // Prefer the thread's own agent; fall back to the just-picked agent so a brand-new thread (not yet
  // in cache) keeps its identity instead of flashing a generic header while it loads.
  const currentAgent =
    (threadId !== null ? agentsById.get(thread?.agentId ?? "") : undefined) ??
    (composingAgentId ? agentsById.get(composingAgentId) : undefined)

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
    setComposingAgentId(agentId)
    navigate("/agents")
  }

  // Return to the home/landing. With a single agent this lands back on its welcome screen.
  const goHome = () => {
    setComposingAgentId(null)
    navigate("/agents")
  }

  const handleSelectThread = (nextThreadId: string) => {
    navigate(`/agents/${encodeURIComponent(nextThreadId)}`)
  }

  const handleSend = async (text: string) => {
    if (isRunning) return
    const targetThreadId = threadId
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

      const agentId = composingAgentId
      if (!agentId) return
      const created = await createThread.mutateAsync({
        body: { agentId, title: deriveTitle(text) },
      })
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
      navigate(`/agents/${encodeURIComponent(newThreadId)}`)
    } catch {
      // A failed post (e.g. 409 active_run_exists) means our view is stale: clear the optimistic
      // echo and refetch thread state so the composer reflects the real active run.
      setPendingUser(null)
      if (targetThreadId !== null) {
        void queryClient.invalidateQueries({
          queryKey: getAgentThreadQueryKey({ path: { threadId: targetThreadId } }),
        })
      }
      void queryClient.invalidateQueries({ queryKey: listAgentThreadsQueryKey() })
    }
  }

  if (agentsQuery.isLoading) {
    return <LoadingPage label="Loading agents…" />
  }
  if (agentsQuery.isError) {
    return <ErrorPage title="Agents unavailable" description="Could not load registered agents." />
  }
  if (agents.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon={<MessagesSquare className="size-12 stroke-1" />}
          title="No agents registered"
          description="Agents are discovered from your project's agents/ directory. Define one to start a chat."
        />
      </div>
    )
  }

  const home = threadId === null && composingAgentId === null
  const pendingUserText =
    pendingUser &&
    pendingUser.threadId === threadId &&
    !(pendingUser.messageId && messages.some((message) => message.id === pendingUser.messageId))
      ? pendingUser.text
      : null

  return (
    <div className="flex h-full min-h-0 flex-col">
      {home ? (
        <AgentsHome
          agents={agents}
          threads={threads}
          agentsById={agentsById}
          threadsError={threadsQuery.isError ? "Could not load chats." : null}
          onPickAgent={startNewChatWith}
          onSelectThread={handleSelectThread}
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
          agents={agents}
          agentThreads={agentThreads}
          canGoHome={canGoHome}
          onSend={handleSend}
          onBackHome={goHome}
          onNewChat={() => {
            if (currentAgent) startNewChatWith(currentAgent.id)
          }}
          onPickAgent={startNewChatWith}
          onSelectThread={handleSelectThread}
          composerDisabled={isRunning}
          composerPending={postMessage.isPending || createThread.isPending}
          composerPlaceholder={currentAgent ? `Message ${currentAgent.name}…` : "Send a message…"}
        />
      )}
    </div>
  )
}

function deriveTitle(text: string): string {
  const firstLine = text.split("\n")[0]?.trim() ?? ""
  if (firstLine.length <= 60) return firstLine
  return `${firstLine.slice(0, 57)}…`
}
