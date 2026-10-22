import { isSixbApiError } from "@sixb/client"
import {
  cancelAgentRunMutation,
  createAgentThreadMutation,
  getAgentOptions,
  getAgentThreadOptions,
  getAgentThreadQueryKey,
  listAgentThreadMessagesOptions,
  listAgentThreadMessagesQueryKey,
  listAgentThreadRunsOptions,
  listAgentThreadRunsQueryKey,
  listAgentThreadsInfiniteOptions,
  listAgentThreadsQueryKey,
  listModelsOptions,
  postAgentThreadMessageMutation,
  recreateAgentThreadSandboxMutation,
  retryAgentRunMutation,
  useAgentActivityStream,
} from "@sixb/client/hooks"
import { MODEL_REASONING_LEVELS, type ModelReasoningLevel } from "@sixb/core/models"
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useMemo, useState } from "react"
import { useCurrentUser } from "../../session"
import { useAgentMessages } from "../i18n"
import {
  type ModelPreference,
  preferenceWithoutReasoning,
  preferenceWithReasoning,
  resolveModelSelection,
} from "../model-selection"
import { type RequesterSettings, sendWithRequesterSettings } from "../requester-settings"
import {
  EXTENDED_WAITING_STATUS_MS,
  isActiveAgentRunStatus,
  presentActiveTurn,
  selectActiveRunId,
  shouldShowExtendedWaitingStatus,
} from "../run-presentation"
import { canRetryRun, canStopRun, isShared, requestedBySomeoneElse, threadAccess } from "../sharing"
import { THREAD_PAGE_SIZE } from "../thread-navigation"
import type { AgentContextEntryInput, AgentFileRef, AgentRun, LanguageModel } from "../types"
import { useThreadStream } from "./use-thread-stream"

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

/** The conversations others shared with the reader: one page, newest first. */
const SHARED_THREAD_LIST_QUERY = {
  sharedWithMe: "true" as const,
  limit: String(THREAD_PAGE_SIZE),
  order: "desc" as const,
}

const MODEL_PREFERENCE_KEY = "sixb.agent-ui.model-preference"
const REASONING_LEVELS = new Set<string>(MODEL_REASONING_LEVELS)

export interface UseAgentConversationInput {
  readonly threadId: string | null
  readonly embedded?: boolean
  readonly onThreadCreated: (threadId: string) => void
}

export type AgentConversation = ReturnType<typeof useAgentConversation>

/** Shared route-independent controller for full-page and embedded agent conversations. */
export function useAgentConversation({
  threadId,
  embedded = false,
  onThreadCreated,
}: UseAgentConversationInput) {
  const labels = useAgentMessages().chat
  const queryClient = useQueryClient()
  const user = useCurrentUser()
  const agentQuery = useQuery(getAgentOptions())
  const modelsQuery = useQuery(listModelsOptions())
  const refreshThreads = () =>
    queryClient.invalidateQueries({ queryKey: listAgentThreadsQueryKey() })
  const activityStream = useAgentActivityStream({
    enabled: !embedded,
    onActivity: (event) => {
      // Someone else's turn in a shared conversation shows only through this feed: read the open
      // thread again so its run is followed live. A run the view already follows streams itself.
      if (event.threadId === threadId && event.runId !== activeRunId) {
        void refreshThread(event.threadId)
        return
      }

      void refreshThreads()
    },
    // On every (re)subscription: catch up with what changed while the socket was away.
    onSubscribed: () => void (threadId === null ? refreshThreads() : refreshThread(threadId)),
  })

  // The project activity feed is primary. Poll only as a focus-aware recovery path while the
  // socket is unavailable, rather than opening one connection per background thread.
  const recoveryPollMs =
    !embedded && (!activityStream.connected || Boolean(activityStream.error)) ? 10_000 : false
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
    refetchInterval: recoveryPollMs,
  })
  // Nothing announces a new share or a removal: read the list again when the reader comes back.
  const sharedThreadsQuery = useInfiniteQuery({
    ...listAgentThreadsInfiniteOptions({ query: SHARED_THREAD_LIST_QUERY }),
    initialPageParam: { query: SHARED_THREAD_LIST_QUERY },
    getNextPageParam: (lastPage, pages) => {
      if (!lastPage.hasMore) return undefined

      return {
        query: {
          ...SHARED_THREAD_LIST_QUERY,
          offset: String(pages.length * THREAD_PAGE_SIZE),
        },
      }
    },
    refetchInterval: recoveryPollMs,
    refetchOnWindowFocus: true,
  })
  const currentAgent = agentQuery.data
  const models = useMemo(() => modelsQuery.data?.language ?? [], [modelsQuery.data])
  const [modelPreference, setModelPreference] = useState(readModelPreference)
  const modelSelection = resolveModelSelection(models, modelPreference)
  const selectedModel = modelSelection.model
  const selectedReasoning = modelSelection.reasoning
  const threads = useMemo(
    () => threadsQuery.data?.pages.flatMap((page) => page.threads) ?? [],
    [threadsQuery.data]
  )

  const sharedThreads = useMemo(
    () => sharedThreadsQuery.data?.pages.flatMap((page) => page.threads) ?? [],
    [sharedThreadsQuery.data]
  )

  const threadQuery = useQuery({
    ...getAgentThreadOptions({ path: { threadId: threadId ?? "" } }),
    enabled: threadId !== null,
    refetchInterval: recoveryPollMs,
    // A shared thread can lose its reader without an event: read it again when they come back.
    refetchOnWindowFocus: (query) => isShared(query.state.data ?? null),
  })
  // A 404 after a read means the reader no longer reads it, such as a participant someone removed:
  // the last copy the query keeps must not stand in for it.
  const threadGone = isSixbApiError(threadQuery.error) && threadQuery.error.status === 404
  const thread =
    threadId !== null && !threadGone
      ? (threadQuery.data ??
        threads.find((candidate) => candidate.id === threadId) ??
        sharedThreads.find((candidate) => candidate.id === threadId) ??
        null)
      : null
  const threadUnavailable = threadId !== null && !threadQuery.isLoading && thread === null
  const removedFromThread =
    threadGone && threadQuery.data !== undefined && threadAccess(threadQuery.data, user) !== "owner"
  const access = thread ? threadAccess(thread, user) : "owner"

  const messagesQuery = useQuery({
    ...listAgentThreadMessagesOptions({
      path: { threadId: threadId ?? "" },
      query: { order: "asc" },
    }),
    enabled: threadId !== null,
    refetchInterval: recoveryPollMs,
  })
  const messages = useMemo(() => messagesQuery.data?.messages ?? [], [messagesQuery.data])
  const authors = messagesQuery.data?.authors
  const runsQuery = useQuery({
    ...listAgentThreadRunsOptions({
      path: { threadId: threadId ?? "" },
      query: { limit: "50", order: "desc" },
    }),
    enabled: threadId !== null,
    refetchInterval: recoveryPollMs,
  })
  const runs = useMemo(() => runsQuery.data?.runs ?? [], [runsQuery.data])
  const latestRun = runs[0] ?? null

  const [pendingSend, setPendingSend] = useState<PendingSend | null>(null)
  const [pendingUser, setPendingUser] = useState<PendingUser | null>(null)
  const [sendError, setSendError] = useState<{
    threadId: string | null
    failure: TurnFailure
  } | null>(null)
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
  const recreateSandbox = useMutation(recreateAgentThreadSandboxMutation())

  const presentation = presentActiveTurn({
    activeRunId,
    pendingRun,
    streamRun,
    live,
    runs,
    messages,
    messagesLoading: messagesQuery.isFetching,
  })
  const isRunning = presentation.kind === "responding"
  const waitingLonger = useExtendedWaitingStatus(
    presentation.kind === "responding" ? presentation.queuedRun : null
  )

  useEffect(() => {
    setStoppingRunId((current) => (current === activeRunId ? current : null))
  }, [activeRunId])

  // Who asked for the answer in flight decides whether a participant may stop it.
  const activeRun =
    [pendingRun, streamRun, ...runs].find((run) => run !== null && run.id === activeRunId) ?? null

  const stop = () => {
    if (threadId === null || activeRunId === null) return
    setStoppingRunId(activeRunId)
    cancelRun.mutate(
      { path: { threadId }, body: { runId: activeRunId } },
      {
        onError: () => {
          setStoppingRunId(null)
          setSendError({ threadId, failure: "stop" })
          void refreshThread(threadId)
        },
      }
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
        const response = await sendWithRequesterSettings((settings) =>
          postMessage.mutateAsync({
            path: { threadId: targetThreadId },
            body: messageBody(text, attachments, context, modelSelection.request, settings),
          })
        )
        recordAcceptedSend(response.run)
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: listAgentThreadMessagesQueryKey({ path: { threadId: targetThreadId } }),
          }),
          queryClient.invalidateQueries({ queryKey: listAgentThreadsQueryKey() }),
        ])
        return
      }

      if (!currentAgent) return
      const created = await createThread.mutateAsync({
        body: { title: deriveTitle(text) },
      })
      createdThreadId = created.thread.id
      setPendingUser({ threadId: createdThreadId, text, attachments, context, messageId: null })
      const newThreadId = createdThreadId
      const response = await sendWithRequesterSettings((settings) =>
        postMessage.mutateAsync({
          path: { threadId: newThreadId },
          body: messageBody(text, attachments, context, modelSelection.request, settings),
        })
      )
      recordAcceptedSend(response.run)
      await queryClient.invalidateQueries({ queryKey: listAgentThreadsQueryKey() })
      onThreadCreated(createdThreadId)
    } catch (error) {
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
        failure: sendFailure(error),
      })
      if (createdThreadId) onThreadCreated(createdThreadId)

      // A refusal can mean another turn holds the thread: read who asked for it, too.
      if (targetThreadId !== null) void refreshThread(targetThreadId)
      else void queryClient.invalidateQueries({ queryKey: listAgentThreadsQueryKey() })
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
          void refreshThread(threadId)
        },
        onError: () => {
          setSendError({ threadId, failure: "retry" })
          void refreshThread(threadId)
        },
      }
    )
  }

  const refreshThread = (threadId: string) =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: listAgentThreadMessagesQueryKey({ path: { threadId } }),
      }),
      queryClient.invalidateQueries({
        queryKey: listAgentThreadRunsQueryKey({ path: { threadId } }),
      }),
      queryClient.invalidateQueries({
        queryKey: getAgentThreadQueryKey({ path: { threadId } }),
      }),
      queryClient.invalidateQueries({ queryKey: listAgentThreadsQueryKey() }),
    ])

  // Sixb writes the continuation for the model, with the cut-short turn's model and reasoning; the
  // transcript shows no message for it.
  const continueAfterTimeout = async () => {
    if (isRunning || threadId === null) return
    setSendError(null)
    try {
      const response = await sendWithRequesterSettings((settings) =>
        postMessage.mutateAsync({ path: { threadId }, body: { continue: true, ...settings } })
      )
      setPendingSend({ run: response.run })
      await refreshThread(threadId)
    } catch (error) {
      setSendError({ threadId, failure: sendFailure(error) })
      void refreshThread(threadId)
    }
  }

  const handleRecreateSandbox = () => {
    if (!thread?.sandboxState || isRunning || access !== "owner") return
    recreateSandbox.mutate(
      {
        path: { threadId: thread.id },
        body: { expectedSandboxName: thread.sandboxState.name },
      },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({
            queryKey: getAgentThreadQueryKey({ path: { threadId: thread.id } }),
          })
          void refreshThreads()
        },
      }
    )
  }

  // Choosing a model starts from that model's default reasoning.
  const selectModel = (model: LanguageModel) => {
    updateModelPreference({ model: { provider: model.provider, modelId: model.modelId } })
  }

  const selectReasoning = (reasoning: ModelReasoningLevel) => {
    if (!selectedModel?.reasoningLevels.includes(reasoning)) return
    updateModelPreference(preferenceWithReasoning(modelSelection, reasoning))
  }

  const resetReasoning = () => updateModelPreference(preferenceWithoutReasoning(modelSelection))

  /** Follow the project defaults again, including later changes to them. */
  const resetModelSelection = () => updateModelPreference(null)

  const updateModelPreference = (preference: ModelPreference | null) => {
    setModelPreference(preference)
    writeModelPreference(preference)
  }

  const agentThreads = threads.filter((entry) => entry.id !== threadId)
  const pendingUserForThread =
    pendingUser &&
    pendingUser.threadId === threadId &&
    !(pendingUser.messageId && messages.some((message) => message.id === pendingUser.messageId))
      ? pendingUser
      : null

  const sandboxRecovery =
    thread?.sandboxState &&
    !isRunning &&
    ["busy", "blocked", "unavailable"].includes(thread.sandboxState.status)
      ? thread.sandboxState
      : null

  return {
    agentLoading: agentQuery.isLoading,
    sandboxRecovery,
    recreatingSandbox: recreateSandbox.isPending,
    sandboxRecoveryError: recreateSandbox.isError,
    recreateSandbox: handleRecreateSandbox,
    agentError: agentQuery.isError,
    models,
    modelsLoading: modelsQuery.isLoading,
    modelsError: modelsQuery.isError,
    selectedModel,
    selectedReasoning,
    usingDefaultModel: modelSelection.request === undefined,
    selectModel,
    selectReasoning,
    resetReasoning,
    resetModelSelection,
    threads,
    threadsError: threadsQuery.isError,
    threadsHasMore: threadsQuery.hasNextPage,
    threadsLoadingMore: threadsQuery.isFetchingNextPage,
    threadsLoadMoreError: threadsQuery.isFetchNextPageError,
    loadMoreThreads: () => threadsQuery.fetchNextPage(),
    threadUnavailable,
    currentAgent,
    currentThread: thread,
    agentThreads,
    sharedThreads,
    sharedThreadsTotal: sharedThreadsQuery.data?.pages[0]?.total ?? 0,
    sharedThreadsError: sharedThreadsQuery.isError,
    sharedThreadsHasMore: sharedThreadsQuery.hasNextPage,
    sharedThreadsLoadingMore: sharedThreadsQuery.isFetchingNextPage,
    sharedThreadsLoadMoreError: sharedThreadsQuery.isFetchNextPageError,
    loadMoreSharedThreads: () => sharedThreadsQuery.fetchNextPage(),
    access,
    user,
    removedFromThread,
    messages,
    authors,
    messagesLoading: threadId !== null && messagesQuery.isLoading,
    messagesError: threadId !== null && messagesQuery.isError ? labels.messagesLoadFailed : null,
    live,
    reconnecting,
    pendingUser: pendingUserForThread,
    anchorCurrentTurn: Boolean((pendingUser && pendingUser.threadId === threadId) || pendingRun),
    isRunning,
    waitingLonger,
    presentation,
    sendError:
      sendError && sendError.threadId === threadId
        ? failureMessage(sendError.failure, requestedBySomeoneElse(activeRun, user), labels)
        : null,
    draftReseed,
    composerPending: postMessage.isPending || createThread.isPending,
    stopping: stoppingRunId !== null && stoppingRunId === activeRunId,
    retrying: retryRun.isPending,
    canStop: canStopRun(activeRun, access, user),
    /** Who asked for the answer in flight, when it is someone other than the reader. */
    answeringFor:
      isRunning && activeRun && requestedBySomeoneElse(activeRun, user)
        ? (activeRun.requestedBy ?? null)
        : null,
    canRetry: (run: AgentRun) => canRetryRun(run, user),
    canRecreateSandbox: access === "owner",
    send,
    stop,
    retry,
    continueAfterTimeout,
  }
}

/** Why a turn did not start or stop, as the composer tells it. */
type TurnFailure = "send" | "busy" | "sandbox" | "retry" | "stop"

/** A message that did not go out: another answer holds the thread, the sandbox is away, or else. */
function sendFailure(error: unknown): TurnFailure {
  if (!isSixbApiError(error) || error.status !== 409) return "send"
  if (error.code === "active_run_exists") return "busy"
  if (error.code === "sandbox_execution_unavailable") return "sandbox"

  return "send"
}

/**
 * Said once the thread is read again, so a busy thread names whose answer holds it when the reader
 * can tell.
 */
function failureMessage(
  failure: TurnFailure,
  someoneElseAnswers: boolean,
  labels: ReturnType<typeof useAgentMessages>["chat"]
): string {
  switch (failure) {
    case "busy":
      return someoneElseAnswers ? labels.busyOther : labels.busy
    case "sandbox":
      return labels.sandboxUnavailable
    case "retry":
      return labels.retryFailed
    case "stop":
      return labels.stopFailed
    default:
      return labels.sendFailed
  }
}

function messageBody(
  text: string,
  attachments: readonly AgentFileRef[],
  context: readonly AgentContextEntryInput[],
  selection: ModelPreference | undefined,
  settings: RequesterSettings
) {
  return {
    text,
    ...(selection === undefined ? {} : selection),
    ...settings,
    ...(attachments.length === 0 ? {} : { attachments: [...attachments] }),
    ...(context.length === 0 ? {} : { context: [...context] }),
  }
}

function readModelPreference(): ModelPreference | null {
  if (typeof window === "undefined") return null
  try {
    const value = JSON.parse(window.localStorage.getItem(MODEL_PREFERENCE_KEY) ?? "null") as unknown
    if (!isModelPreference(value)) return null
    return value
  } catch {
    return null
  }
}

function writeModelPreference(preference: ModelPreference | null): void {
  if (typeof window === "undefined") return
  try {
    if (preference === null) window.localStorage.removeItem(MODEL_PREFERENCE_KEY)
    else window.localStorage.setItem(MODEL_PREFERENCE_KEY, JSON.stringify(preference))
  } catch {
    // Restricted browser contexts may disable storage; the in-memory preference still works.
  }
}

function isModelPreference(value: unknown): value is ModelPreference {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as {
    readonly model?: { readonly provider?: unknown; readonly modelId?: unknown }
    readonly reasoning?: unknown
  }
  return (
    (candidate.model === undefined ||
      (typeof candidate.model.provider === "string" &&
        typeof candidate.model.modelId === "string")) &&
    (candidate.reasoning === undefined ||
      (typeof candidate.reasoning === "string" && REASONING_LEVELS.has(candidate.reasoning))) &&
    (candidate.model !== undefined || candidate.reasoning !== undefined)
  )
}

function deriveTitle(text: string): string {
  const firstLine = text.split("\n")[0]?.trim() ?? ""
  return firstLine.length <= 60 ? firstLine : `${firstLine.slice(0, 57)}...`
}

function useExtendedWaitingStatus(run: Pick<AgentRun, "status" | "createdAt"> | null): boolean {
  const [visible, setVisible] = useState(() => shouldShowExtendedWaitingStatus(run))

  useEffect(() => {
    if (!run || run.status !== "queued") {
      setVisible(false)
      return
    }
    const remaining = EXTENDED_WAITING_STATUS_MS - (Date.now() - Date.parse(run.createdAt))
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
