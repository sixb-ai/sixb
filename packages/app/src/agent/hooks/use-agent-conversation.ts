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
import type { ComposerProps } from "../components/composer"
import type { SandboxRecoveryProps } from "../components/sandbox-recovery"
import type { TranscriptProps } from "../components/transcript"
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
  offersContinue,
  presentActiveTurn,
  selectActiveRunId,
  shouldShowExtendedWaitingStatus,
} from "../run-presentation"
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

const MODEL_PREFERENCE_KEY = "sixb.agent-ui.model-preference"
const REASONING_LEVELS = new Set<string>(MODEL_REASONING_LEVELS)

export interface UseAgentConversationInput {
  /** The open thread, or null to start a new one with the next message. */
  readonly threadId: string | null
  /** The first message created a thread; show it from now on. */
  readonly onThreadCreated: (threadId: string) => void
}

/** The parts of {@link ComposerProps} a conversation decides; the page adds the rest. */
export type ConversationComposerProps = Pick<
  ComposerProps,
  | "onSend"
  | "error"
  | "disabled"
  | "pending"
  | "running"
  | "stopping"
  | "onStop"
  | "models"
  | "selectedModel"
  | "selectedReasoning"
  | "modelsLoading"
  | "modelsError"
  | "onSelectModel"
  | "onSelectReasoning"
  | "onResetReasoning"
  | "usingDefaultModel"
  | "onResetModelSelection"
  | "draft"
  | "draftAttachments"
  | "draftContext"
  | "draftNonce"
>

export type AgentConversation = ReturnType<typeof useAgentConversation>

/**
 * Everything one conversation with the project's agent needs: its threads, messages, live run and
 * model choice, and the actions on them. Route-independent; the built-in chat and custom chats
 * both render it, typically by spreading `transcriptProps` and `composerProps`.
 */
export function useAgentConversation({ threadId, onThreadCreated }: UseAgentConversationInput) {
  const labels = useAgentMessages().chat
  const queryClient = useQueryClient()
  const agentQuery = useQuery(getAgentOptions())
  const modelsQuery = useQuery(listModelsOptions())
  const refreshThreads = () =>
    queryClient.invalidateQueries({ queryKey: listAgentThreadsQueryKey() })
  const activityStream = useAgentActivityStream({
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
    refetchInterval: !activityStream.connected || activityStream.error ? 10_000 : false,
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

  const threadQuery = useQuery({
    ...getAgentThreadOptions({ path: { threadId: threadId ?? "" } }),
    enabled: threadId !== null,
  })
  const thread =
    threadId !== null
      ? (threadQuery.data ?? threads.find((candidate) => candidate.id === threadId) ?? null)
      : null
  const threadUnavailable = threadId !== null && !threadQuery.isLoading && thread === null

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
        message: labels.sendFailed,
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
    } catch {
      setSendError({ threadId, message: labels.sendFailed })
    }
  }

  const handleRecreateSandbox = () => {
    if (!thread?.sandboxState || isRunning) return
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

  const runningThreadCount =
    threads.filter((entry) => entry.activeRunId !== null).length +
    (threadId &&
    isRunning &&
    !threads.some((entry) => entry.id === threadId && entry.activeRunId !== null)
      ? 1
      : 0)
  const anchorCurrentTurn = Boolean(
    (pendingUser && pendingUser.threadId === threadId) || pendingRun
  )
  const composerPending = postMessage.isPending || createThread.isPending
  const currentSendError = sendError && sendError.threadId === threadId ? sendError.message : null
  const stopping = stoppingRunId !== null && stoppingRunId === activeRunId

  const transcriptProps: TranscriptProps = {
    threadId,
    messages,
    live,
    pendingUserText: pendingUserForThread?.text ?? null,
    pendingUserAttachments: pendingUserForThread?.attachments ?? [],
    pendingUserContext: pendingUserForThread?.context ?? [],
    anchorCurrentTurn,
    awaitingResponse: isRunning,
    waitingLonger,
    failedBeforeResponse: presentation.kind === "failed",
    cancelledBeforeResponse: presentation.kind === "cancelled",
    timeout:
      presentation.kind === "timeout"
        ? {
            hasProgress: presentation.hasProgress,
            ...(presentation.timeoutMs === undefined ? {} : { timeoutMs: presentation.timeoutMs }),
          }
        : undefined,
    interrupted:
      presentation.kind === "interrupted" ? { hasProgress: presentation.hasProgress } : undefined,
    onRetry:
      !sandboxRecovery &&
      (presentation.kind === "failed" ||
        ((presentation.kind === "timeout" || presentation.kind === "interrupted") &&
          !presentation.hasProgress))
        ? () => retry(presentation.run)
        : undefined,
    onContinue: offersContinue({
      presentation,
      isRunning,
      sandboxRecovery: Boolean(sandboxRecovery),
      messages,
    })
      ? continueAfterTimeout
      : undefined,
    retrying: retryRun.isPending,
    continuing: composerPending,
    reconnecting,
  }

  const composerProps: ConversationComposerProps = {
    onSend: send,
    error: currentSendError ?? undefined,
    disabled: isRunning || Boolean(sandboxRecovery),
    pending: composerPending,
    running: isRunning,
    stopping,
    onStop: stop,
    models,
    selectedModel,
    selectedReasoning,
    modelsLoading: modelsQuery.isLoading,
    modelsError: modelsQuery.isError,
    onSelectModel: selectModel,
    onSelectReasoning: selectReasoning,
    onResetReasoning: resetReasoning,
    usingDefaultModel: modelSelection.request === undefined,
    onResetModelSelection: resetModelSelection,
    draft: draftReseed.text,
    draftAttachments: draftReseed.attachments,
    draftContext: draftReseed.context,
    draftNonce: draftReseed.nonce,
  }

  const sandboxRecoveryProps: SandboxRecoveryProps | null = sandboxRecovery
    ? {
        pending: recreateSandbox.isPending,
        error: recreateSandbox.isError,
        onRecreate: handleRecreateSandbox,
      }
    : null

  return {
    agentLoading: agentQuery.isLoading,
    sandboxRecovery,
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
    /** Threads with a run in progress, counting this one while its run starts. */
    runningThreadCount,
    threadsError: threadsQuery.isError,
    threadsHasMore: threadsQuery.hasNextPage,
    threadsLoadingMore: threadsQuery.isFetchingNextPage,
    threadsLoadMoreError: threadsQuery.isFetchNextPageError,
    loadMoreThreads: () => threadsQuery.fetchNextPage(),
    threadUnavailable,
    currentAgent,
    currentThread: thread,
    agentThreads,
    messages,
    messagesLoading: threadId !== null && messagesQuery.isLoading,
    messagesError: threadId !== null && messagesQuery.isError ? labels.messagesLoadFailed : null,
    live,
    reconnecting,
    pendingUser: pendingUserForThread,
    anchorCurrentTurn,
    isRunning,
    waitingLonger,
    presentation,
    sendError: currentSendError,
    draftReseed,
    composerPending,
    stopping,
    retrying: retryRun.isPending,
    send,
    stop,
    retry,
    continueAfterTimeout,
    /** Spread into `<Transcript>`. */
    transcriptProps,
    /** Spread into `<Composer>`, then add the page's own props such as `placeholder`. */
    composerProps,
    /** Spread into `<SandboxRecovery>` while set: the composer stays disabled until it is resolved. */
    sandboxRecoveryProps,
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
