import {
  cancelAgentRunMutation,
  createAgentThreadMutation,
  getAgentThreadOptions,
  getAgentThreadQueryKey,
  listAgentsOptions,
  listAgentThreadMessagesOptions,
  listAgentThreadMessagesQueryKey,
  listAgentThreadRunsOptions,
  listAgentThreadRunsQueryKey,
  listAgentThreadsInfiniteOptions,
  listAgentThreadsQueryKey,
  postAgentThreadMessageMutation,
  retryAgentRunMutation,
  useAgentActivityStream,
} from "@sixb/client/hooks"
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useMemo, useState } from "react"
import {
  DELAYED_WAITING_COPY_MS,
  isActiveAgentRunStatus,
  presentActiveTurn,
  selectActiveRunId,
  shouldShowDelayedWaitingCopy,
} from "../runPresentation"
import { THREAD_PAGE_SIZE } from "../threadNavigation"
import type { AgentContextEntryInput, AgentFileRef, AgentRun } from "../types"
import { useThreadStream } from "./useThreadStream"

interface PendingSend {
  readonly run: AgentRun
}

interface PendingUser {
  readonly threadId: string
  readonly text: string
  readonly attachments: readonly AgentFileRef[]
  readonly context: readonly AgentContextEntryInput[]
  messageId: string | null
}

const THREAD_LIST_QUERY = {
  limit: String(THREAD_PAGE_SIZE),
  order: "desc" as const,
}

export interface UseAgentConversationInput {
  readonly threadId: string | null
  readonly draftAgentId: string | null
  readonly pinnedAgentId?: string
  readonly onThreadCreated: (threadId: string) => void
}

/** Shared route-independent controller for full-page and embedded agent conversations. */
export function useAgentConversation({
  threadId,
  draftAgentId: requestedDraftAgentId,
  pinnedAgentId,
  onThreadCreated,
}: UseAgentConversationInput) {
  const queryClient = useQueryClient()
  const agentsQuery = useQuery(listAgentsOptions())
  const refreshThreads = () =>
    queryClient.invalidateQueries({ queryKey: listAgentThreadsQueryKey() })
  const activityStream = useAgentActivityStream({
    enabled: !pinnedAgentId,
    onActivity: refreshThreads,
    onSubscribed: refreshThreads,
  })
  const threadsQuery = useInfiniteQuery({
    ...listAgentThreadsInfiniteOptions({ query: THREAD_LIST_QUERY }),
    initialPageParam: { query: THREAD_LIST_QUERY },
    getNextPageParam: (lastPage, pages) => {
      if (!lastPage.hasMore) return undefined

      return {
        query: {
          ...THREAD_LIST_QUERY,
          offset: String(pages.length * THREAD_PAGE_SIZE),
        },
      }
    },
    // The project activity feed is primary. Poll only as a focus-aware recovery path while the
    // socket is unavailable, rather than opening one connection per background thread.
    refetchInterval:
      !pinnedAgentId && (!activityStream.connected || activityStream.error) ? 10_000 : false,
  })
  const agents = useMemo(
    () =>
      pinnedAgentId
        ? (agentsQuery.data ?? []).filter((agent) => agent.id === pinnedAgentId)
        : (agentsQuery.data ?? []),
    [agentsQuery.data, pinnedAgentId]
  )
  const threads = useMemo(
    () => threadsQuery.data?.pages.flatMap((page) => page.threads) ?? [],
    [threadsQuery.data]
  )
  const threadTotal = threadsQuery.data?.pages[0]?.total ?? threads.length
  const agentsById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents])
  const draftAgentId =
    threadId === null
      ? (pinnedAgentId ?? requestedDraftAgentId ?? (agents.length === 1 ? agents[0].id : null))
      : null

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
  const runsQuery = useQuery({
    ...listAgentThreadRunsOptions({
      path: { threadId: threadId ?? "" },
      query: { limit: "50", order: "desc" },
    }),
    enabled: threadId !== null,
  })
  const runs = useMemo(() => runsQuery.data?.runs ?? [], [runsQuery.data])
  const latestRun = runs[0] ?? null

  const [pendingSend, setPendingSend] = useState<PendingSend | null>(null)
  const [pendingUser, setPendingUser] = useState<PendingUser | null>(null)
  const [sendError, setSendError] = useState<{ threadId: string | null; message: string } | null>(
    null
  )
  const [draftReseed, setDraftReseed] = useState<{
    text: string
    attachments: readonly AgentFileRef[]
    context: readonly AgentContextEntryInput[]
    nonce: number
  }>({ text: "", attachments: [], context: [], nonce: 0 })
  const [stoppingRunId, setStoppingRunId] = useState<string | null>(null)

  const pendingRun =
    pendingSend && threadId !== null && pendingSend.run.threadId === threadId
      ? pendingSend.run
      : null
  const activeRunId =
    threadId !== null
      ? selectActiveRunId({ pendingRun, threadActiveRunId: thread?.activeRunId ?? null, latestRun })
      : null
  const { live, run: streamRun, reconnecting } = useThreadStream({ threadId, runId: activeRunId })
  const finalizedMessageInDurable =
    live.finalizedMessageId !== null &&
    messages.some((message) => message.id === live.finalizedMessageId)

  useEffect(() => {
    if (!pendingSend || pendingSend.run.id !== activeRunId) return
    const terminalFromSnapshot =
      streamRun?.id === pendingSend.run.id && !isActiveAgentRunStatus(streamRun.status)
    const terminalFromEvent = live.runId === pendingSend.run.id && live.finishStatus !== null
    if (!terminalFromSnapshot && !terminalFromEvent) return
    if (live.finalizedMessageId && !finalizedMessageInDurable) return
    if (!live.finalizedMessageId && !runs.some((run) => run.id === pendingSend.run.id)) return
    setPendingSend(null)
  }, [
    pendingSend,
    activeRunId,
    streamRun,
    live.runId,
    live.finishStatus,
    live.finalizedMessageId,
    finalizedMessageInDurable,
    runs,
  ])

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

  useEffect(() => {
    setSendError((current) => (current && current.threadId === threadId ? current : null))
  }, [threadId])

  const createThread = useMutation(createAgentThreadMutation())
  const postMessage = useMutation(postAgentThreadMessageMutation())
  const cancelRun = useMutation(cancelAgentRunMutation())
  const retryRun = useMutation(retryAgentRunMutation())

  const presentation = presentActiveTurn({
    activeRunId,
    pendingRun,
    streamRun,
    live,
    runs,
    messages,
    messagesLoading: messagesQuery.isLoading,
  })
  const isRunning = presentation.kind === "responding"
  const waitingLonger = useDelayedWaitingCopy(
    presentation.kind === "responding" ? presentation.queuedRun : null
  )

  useEffect(() => {
    setStoppingRunId((current) => (current === activeRunId ? current : null))
  }, [activeRunId])

  const stop = () => {
    if (threadId === null || activeRunId === null) return
    setStoppingRunId(activeRunId)
    cancelRun.mutate(
      { path: { threadId }, body: { runId: activeRunId } },
      { onError: () => setStoppingRunId(null) }
    )
  }

  const send = async (
    text: string,
    attachments: readonly AgentFileRef[],
    context: readonly AgentContextEntryInput[]
  ) => {
    if (isRunning) return
    setSendError(null)
    const targetThreadId = threadId
    let createdThreadId: string | null = null
    try {
      if (targetThreadId !== null) {
        setPendingUser({ threadId: targetThreadId, text, attachments, context, messageId: null })
        const response = await postMessage.mutateAsync({
          path: { threadId: targetThreadId },
          body: messageBody(text, attachments, context),
        })
        recordAcceptedSend(response.run)
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: listAgentThreadMessagesQueryKey({ path: { threadId: targetThreadId } }),
          }),
          queryClient.invalidateQueries({ queryKey: listAgentThreadsQueryKey() }),
        ])
        return
      }

      if (!draftAgentId) return
      const created = await createThread.mutateAsync({
        body: { agentId: draftAgentId, title: deriveTitle(text) },
      })
      createdThreadId = created.thread.id
      setPendingUser({ threadId: createdThreadId, text, attachments, context, messageId: null })
      const response = await postMessage.mutateAsync({
        path: { threadId: createdThreadId },
        body: messageBody(text, attachments, context),
      })
      recordAcceptedSend(response.run)
      await queryClient.invalidateQueries({ queryKey: listAgentThreadsQueryKey() })
      onThreadCreated(createdThreadId)
    } catch {
      // Restore the exact submitted snapshot. In particular, do not re-read ambient page context:
      // navigation may have changed it while the request was in flight.
      setPendingUser(null)
      setDraftReseed((current) => ({
        text,
        attachments,
        context,
        nonce: current.nonce + 1,
      }))
      setSendError({
        threadId: createdThreadId ?? targetThreadId,
        message: "Couldn't send your message. Please try again.",
      })
      if (createdThreadId) onThreadCreated(createdThreadId)
      if (targetThreadId !== null) {
        void queryClient.invalidateQueries({
          queryKey: getAgentThreadQueryKey({ path: { threadId: targetThreadId } }),
        })
      }
      void queryClient.invalidateQueries({ queryKey: listAgentThreadsQueryKey() })
    }
  }

  const recordAcceptedSend = (run: AgentRun) => {
    setPendingSend({ run })
    setPendingUser((current) =>
      current && current.threadId === run.threadId
        ? { ...current, messageId: run.triggerMessageId }
        : current
    )
  }

  const retry = (failedRun: AgentRun) => {
    if (threadId === null) return
    retryRun.mutate(
      { path: { threadId, runId: failedRun.id } },
      {
        onSuccess: (response) => {
          setPendingSend({ run: response.run })
          void Promise.all([
            queryClient.invalidateQueries({
              queryKey: listAgentThreadRunsQueryKey({ path: { threadId } }),
            }),
            queryClient.invalidateQueries({
              queryKey: getAgentThreadQueryKey({ path: { threadId } }),
            }),
            queryClient.invalidateQueries({ queryKey: listAgentThreadsQueryKey() }),
          ])
        },
      }
    )
  }

  const currentAgent =
    (threadId !== null ? agentsById.get(thread?.agentId ?? "") : undefined) ??
    (draftAgentId ? agentsById.get(draftAgentId) : undefined)
  const agentThreads = currentAgent
    ? threads
        .filter((entry) => entry.agentId === currentAgent.id && entry.id !== threadId)
        .slice(0, 8)
    : []
  const pendingUserForThread =
    pendingUser &&
    pendingUser.threadId === threadId &&
    !(pendingUser.messageId && messages.some((message) => message.id === pendingUser.messageId))
      ? pendingUser
      : null

  return {
    agents,
    agentsById,
    agentsLoading: agentsQuery.isLoading,
    agentsError: agentsQuery.isError,
    threads,
    threadTotal,
    threadsError: threadsQuery.isError,
    threadsHasMore: threadsQuery.hasNextPage,
    threadsLoadingMore: threadsQuery.isFetchingNextPage,
    threadsLoadMoreError: threadsQuery.isFetchNextPageError,
    loadMoreThreads: () => threadsQuery.fetchNextPage(),
    draftAgentId,
    home: threadId === null && draftAgentId === null,
    currentAgent,
    agentThreads,
    canGoHome: !pinnedAgentId && agents.length > 1,
    messages,
    messagesLoading: threadId !== null && messagesQuery.isLoading,
    messagesError:
      threadId !== null && messagesQuery.isError ? "Could not load this conversation." : null,
    live,
    reconnecting,
    pendingUser: pendingUserForThread,
    anchorCurrentTurn: Boolean((pendingUser && pendingUser.threadId === threadId) || pendingRun),
    isRunning,
    waitingLonger,
    presentation,
    sendError: sendError && sendError.threadId === threadId ? sendError.message : null,
    draftReseed,
    composerPending: postMessage.isPending || createThread.isPending,
    stopping: stoppingRunId !== null && stoppingRunId === activeRunId,
    retrying: retryRun.isPending,
    send,
    stop,
    retry,
  }
}

function messageBody(
  text: string,
  attachments: readonly AgentFileRef[],
  context: readonly AgentContextEntryInput[]
) {
  return {
    text,
    ...(attachments.length === 0 ? {} : { attachments: [...attachments] }),
    ...(context.length === 0 ? {} : { context: [...context] }),
  }
}

function deriveTitle(text: string): string {
  const firstLine = text.split("\n")[0]?.trim() ?? ""
  return firstLine.length <= 60 ? firstLine : `${firstLine.slice(0, 57)}...`
}

function useDelayedWaitingCopy(run: Pick<AgentRun, "status" | "createdAt"> | null): boolean {
  const [visible, setVisible] = useState(() => shouldShowDelayedWaitingCopy(run))

  useEffect(() => {
    if (!run || run.status !== "queued") {
      setVisible(false)
      return
    }
    const remaining = DELAYED_WAITING_COPY_MS - (Date.now() - Date.parse(run.createdAt))
    if (remaining <= 0) {
      setVisible(true)
      return
    }
    setVisible(false)
    const timer = window.setTimeout(() => setVisible(true), remaining)
    return () => window.clearTimeout(timer)
  }, [run])

  return visible
}
