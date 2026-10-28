import { isSixbApiError, type ListAgentThreadApprovalsResponse } from "@sixb/client"
import {
  cancelAgentRunMutation,
  createAgentThreadMutation,
  decideAgentApprovalMutation,
  getAgentOptions,
  getAgentPreferencesOptions,
  getAgentPreferencesQueryKey,
  getAgentThreadOptions,
  getAgentThreadQueryKey,
  listAgentApprovalsQueryKey,
  listAgentThreadApprovalsOptions,
  listAgentThreadApprovalsQueryKey,
  listAgentThreadMessagesOptions,
  listAgentThreadMessagesQueryKey,
  listAgentThreadRunsOptions,
  listAgentThreadRunsQueryKey,
  listAgentThreadsQueryKey,
  listModelsOptions,
  postAgentThreadMessageMutation,
  recreateAgentThreadSandboxMutation,
  retryAgentRunMutation,
  setAgentThreadApprovalModeMutation,
  updateAgentPreferencesMutation,
  useAgentActivityStream,
} from "@sixb/client/hooks"
import { MODEL_REASONING_LEVELS, type ModelReasoningLevel } from "@sixb/core/models"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useMemo, useRef, useState } from "react"
import { useCurrentUser } from "../../session"
import {
  type AgentApproval,
  type AgentApprovalDecided,
  type AgentApprovalDecision,
  AgentApprovalDecisionError,
  type AgentApprovalDecisionFailure,
  type AgentApprovalMode,
  isAwaitingApproval,
  reportedApprovalOutcomes,
  type TranscriptApprovals,
} from "../approvals"
import type { ComposerProps } from "../components/composer"
import type { SandboxRecoveryProps } from "../components/sandbox-recovery"
import type { TranscriptProps } from "../components/transcript"
import { conversationMessages, conversationTurn, type PendingUserMessage } from "../conversation"
import type { TranscriptDelegation } from "../delegation/context"
import { projectDictation } from "../dictation"
import { useAgentMessages } from "../i18n"
import { knownName } from "../message-authors"
import {
  hasTiers,
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
import { watchRun } from "../run-sounds"
import {
  canRetryRun,
  canStopRun,
  isShared,
  personName,
  requestedBySomeoneElse,
  samePrincipal,
  threadAccess,
  threadOwner,
  userPrincipal,
} from "../sharing"
import type { AgentContextEntryInput, AgentFileRef, AgentRun, LanguageModel } from "../types"
import { useAgentThreadLists } from "./use-thread-lists"
import { useThreadStream } from "./use-thread-stream"

interface PendingSend {
  readonly run: AgentRun
  /**
   * Keep the turn's user message at the top while it answers. A resumed turn has none to show: it
   * continues under the card that resumed it, where the reader already is.
   */
  readonly anchor: boolean
}

/** Keys of the messages the reader sends, so each keeps its key once it is saved. */
let sentMessageCount = 0

/** Enough of a thread's held calls for every card: a turn holds a few, and a thread few turns. */
const THREAD_APPROVALS_QUERY = { limit: "200" }

const MODEL_PREFERENCE_KEY = "sixb.agent-ui.model-preference"
const MODEL_PINS_KEY = "sixb.agent-ui.model-pins"
/** Pins kept per browser, the most recently chosen last; older ones fall back to Auto. */
const MAX_MODEL_PINS = 100
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
  | "hint"
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
  | "modelRouting"
  | "draft"
  | "draftAttachments"
  | "draftContext"
  | "draftNonce"
  | "approvalMode"
  | "onApprovalModeChange"
  | "awaitingApproval"
  | "dictation"
>

export type AgentConversation = ReturnType<typeof useAgentConversation>

/** Why a message, a retry or a stop did not go through, or the approval mode did not change. */
export type AgentConversationSendError =
  /** Another answer holds the conversation; `someoneElse` when another person asked for it. */
  | { readonly code: "busy"; readonly someoneElse: boolean }
  /** The conversation's sandbox must be recovered before another answer. */
  | { readonly code: "sandbox" }
  | { readonly code: "send" | "retry" | "stop" | "approvalMode" }

/** The conversation's messages could not be read. */
export interface AgentConversationMessagesError {
  readonly code: "load"
}

const MESSAGES_LOAD_ERROR: AgentConversationMessagesError = { code: "load" }

/**
 * Everything one conversation with the project's agent needs: its threads, messages, turn and
 * model choice, and the actions on them. Route-independent; the built-in chat and custom chats
 * both render it, by spreading `transcriptProps` and `composerProps` or by drawing `messages` and
 * `turn` themselves.
 */
export function useAgentConversation({ threadId, onThreadCreated }: UseAgentConversationInput) {
  const agentMessages = useAgentMessages()
  const labels = agentMessages.chat
  const queryClient = useQueryClient()
  const user = useCurrentUser()
  const agentQuery = useQuery(getAgentOptions())
  const modelsQuery = useQuery(listModelsOptions())
  const refreshThreads = () =>
    queryClient.invalidateQueries({ queryKey: listAgentThreadsQueryKey() })
  const refreshApprovals = (threadId: string) =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: listAgentThreadApprovalsQueryKey({ path: { threadId } }),
      }),
      queryClient.invalidateQueries({ queryKey: listAgentApprovalsQueryKey() }),
    ])
  const activityStream = useAgentActivityStream({
    onActivity: (event) => {
      // Someone else's turn in a shared conversation shows only through this feed: read the open
      // thread again so its run is followed live. A run the view already follows streams itself.
      if (event.threadId === threadId && event.runId !== activeRunId) {
        void refreshThread(event.threadId)
        return
      }

      void refreshThreads()
    },
    // A held call changed: its card, and the thread list's count of what waits for the reader. Its
    // turn's runs follow from their own events.
    onApprovalActivity: (event) => void refreshApprovals(event.threadId),
    // On every (re)subscription: catch up with what changed while the socket was away.
    onSubscribed: () => {
      void queryClient.invalidateQueries({ queryKey: listAgentApprovalsQueryKey() })
      void (threadId === null ? refreshThreads() : refreshThread(threadId))
    },
  })

  // The project activity feed is primary. Poll only as a focus-aware recovery path while the
  // socket is unavailable, rather than opening one connection per background thread.
  const recoveryPollMs = !activityStream.connected || activityStream.error ? 10_000 : false
  const { threads, sharedThreads, waitingThreadIds } = useAgentThreadLists({
    refetchInterval: recoveryPollMs,
  })
  const currentAgent = agentQuery.data
  const models = useMemo(() => modelsQuery.data?.language ?? [], [modelsQuery.data])
  // With a list, the browser remembers one choice for every conversation. With tiers, each
  // conversation starts on Auto and keeps the model pinned in it; a new one keeps its pin in
  // memory until its first message creates the thread.
  const tiered = hasTiers(models)
  const [modelPreference, setModelPreference] = useState(readModelPreference)
  const [modelPins, setModelPins] = useState(() => readModelPins() ?? {})
  const [newThreadPin, setNewThreadPin] = useState<ModelPreference | null>(null)
  const modelSelection = resolveModelSelection(
    models,
    tiered ? (threadId === null ? newThreadPin : (modelPins[threadId] ?? null)) : modelPreference
  )
  const selectedModel = modelSelection.model
  const selectedReasoning = modelSelection.reasoning
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
  const savedMessages = useMemo(() => messagesQuery.data?.messages ?? [], [messagesQuery.data])
  const approvalOutcomes = useMemo(() => reportedApprovalOutcomes(savedMessages), [savedMessages])
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

  const approvalsQuery = useQuery({
    ...listAgentThreadApprovalsOptions({
      path: { threadId: threadId ?? "" },
      query: THREAD_APPROVALS_QUERY,
    }),
    enabled: threadId !== null,
    refetchInterval: recoveryPollMs,
  })
  // The list is oldest first: past one page, the calls still waiting are read on their own, so the
  // newest always have their record.
  const pendingHereQuery = useQuery({
    ...listAgentThreadApprovalsOptions({
      path: { threadId: threadId ?? "" },
      query: { ...THREAD_APPROVALS_QUERY, status: "pending" },
    }),
    enabled: threadId !== null && approvalsQuery.data?.hasMore === true,
    refetchInterval: recoveryPollMs,
  })
  const approvals = useMemo(() => {
    if (threadId === null) return []
    const read = approvalsQuery.data?.approvals ?? []
    const known = new Set(read.map((approval) => approval.id))
    const pending = (pendingHereQuery.data?.approvals ?? []).filter(
      (approval) => !known.has(approval.id)
    )
    return pending.length === 0 ? read : [...read, ...pending]
  }, [threadId, approvalsQuery.data, pendingHereQuery.data])

  const [pendingSend, setPendingSend] = useState<PendingSend | null>(null)
  const [pendingUser, setPendingUser] = useState<PendingUserMessage | null>(null)
  const [sentKeys, setSentKeys] = useState<ReadonlyMap<string, string>>(() => new Map())
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
  const stopRef = useRef<(approval: AgentApproval) => Promise<void>>(async () => {})
  const decideRef = useRef<NonNullable<TranscriptApprovals["decide"]>>(async () => {
    throw new AgentApprovalDecisionError("failed")
  })
  // The mode the chip shows while a new conversation has no thread to keep it in yet, or until the
  // thread confirms a change.
  const [chosenApprovalMode, setChosenApprovalMode] = useState<{
    readonly threadId: string | null
    readonly mode: AgentApprovalMode
  } | null>(null)
  /** The thread whose answer Continue is asking for, until the API accepts or refuses it. */
  const [continuingThreadId, setContinuingThreadId] = useState<string | null>(null)

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
    savedMessages.some((message) => message.id === live.finalizedMessageId)

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
    if (
      pendingUser.messageId &&
      savedMessages.some((message) => message.id === pendingUser.messageId)
    ) {
      setPendingUser(null)
    }
  }, [pendingUser, threadId, savedMessages])

  useEffect(() => {
    setSendError((current) => (current && current.threadId === threadId ? current : null))
  }, [threadId])

  const createThread = useMutation(createAgentThreadMutation())
  const postMessage = useMutation(postAgentThreadMessageMutation())
  const cancelRun = useMutation(cancelAgentRunMutation())
  const retryRun = useMutation(retryAgentRunMutation())
  const recreateSandbox = useMutation(recreateAgentThreadSandboxMutation())
  const decideApproval = useMutation(decideAgentApprovalMutation())
  // Each runs after the one before, so the last choice is the one the server keeps.
  const saveThreadApprovalMode = useMutation({
    ...setAgentThreadApprovalModeMutation(),
    scope: { id: "agent-thread-approval-mode" },
  })
  const savePreferences = useMutation({
    ...updateAgentPreferencesMutation(),
    scope: { id: "agent-preferences" },
  })

  const preferencesQuery = useQuery({ ...getAgentPreferencesOptions(), retry: false })
  const defaultApprovalMode = preferencesQuery.data?.approvalMode
  const chosenHere =
    chosenApprovalMode && chosenApprovalMode.threadId === threadId ? chosenApprovalMode.mode : null
  // The thread read alone carries the reader's mode in it; a new conversation starts on their
  // default. Unknown until either loads: the chip waits, and a message sent meanwhile carries no
  // mode, so the server picks the reader's own instead of a default shown by mistake.
  const approvalMode: AgentApprovalMode | undefined =
    chosenHere ?? (threadId !== null ? threadQuery.data?.approvalMode : defaultApprovalMode)

  const presentation = presentActiveTurn({
    activeRunId,
    pendingRun,
    streamRun,
    live,
    runs,
    messages: savedMessages,
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
    if (threadId === null || activeRunId === null || !canStop) return
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

  // The turn runs in the mode the chip shows, whatever another device chose since.
  const turnApprovalMode = approvalMode === undefined ? {} : { approvalMode }

  const send = async (
    text: string,
    attachments: readonly AgentFileRef[],
    context: readonly AgentContextEntryInput[]
  ) => {
    if (isRunning) return
    setSendError(null)
    const targetThreadId = threadId
    const key = `sent:${++sentMessageCount}`
    let createdThreadId: string | null = null
    try {
      if (targetThreadId !== null) {
        setPendingUser({
          key,
          threadId: targetThreadId,
          text,
          attachments,
          context,
          messageId: null,
        })
        const response = await sendWithRequesterSettings((settings) =>
          postMessage.mutateAsync({
            path: { threadId: targetThreadId },
            body: {
              ...messageBody(text, attachments, context, modelSelection.request, settings),
              ...turnApprovalMode,
            },
          })
        )
        recordAcceptedSend(response.run, key)
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: listAgentThreadMessagesQueryKey({ path: { threadId: targetThreadId } }),
          }),
          queryClient.invalidateQueries({ queryKey: listAgentThreadsQueryKey() }),
        ])
        return
      }

      if (!currentAgent) return
      const title = deriveTitle(text, attachments)
      const created = await createThread.mutateAsync({
        body: title ? { title } : {},
      })
      createdThreadId = created.thread.id
      setPendingUser({
        key,
        threadId: createdThreadId,
        text,
        attachments,
        context,
        messageId: null,
      })
      const newThreadId = createdThreadId
      // A mode chosen before the thread existed is the reader's choice in it from now on.
      if (chosenHere !== null && chosenHere !== defaultApprovalMode) {
        keepThreadApprovalMode(newThreadId, chosenHere).catch(() =>
          setSendError({ threadId: newThreadId, failure: "approvalMode" })
        )
      }
      const response = await sendWithRequesterSettings((settings) =>
        postMessage.mutateAsync({
          path: { threadId: newThreadId },
          body: {
            ...messageBody(text, attachments, context, modelSelection.request, settings),
            ...turnApprovalMode,
          },
        })
      )
      recordAcceptedSend(response.run, key)
      // The next new conversation starts from the default again.
      setChosenApprovalMode((current) => (current?.threadId === null ? null : current))
      await queryClient.invalidateQueries({ queryKey: listAgentThreadsQueryKey() })
      showCreatedThread(createdThreadId)
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
      if (createdThreadId) showCreatedThread(createdThreadId)

      // A refusal can mean another turn holds the thread: read who asked for it, too.
      if (targetThreadId !== null) void refreshThread(targetThreadId)
      else void queryClient.invalidateQueries({ queryKey: listAgentThreadsQueryKey() })
    }
  }

  // A model pinned before the thread existed stays pinned in it, from the moment it shows.
  const showCreatedThread = (createdThreadId: string) => {
    if (tiered && newThreadPin) pinModel(createdThreadId, newThreadPin)
    onThreadCreated(createdThreadId)
  }

  // The saved message keeps the key the reader's pending copy had.
  const recordAcceptedSend = (run: AgentRun, key: string) => {
    watchRun(run)
    setPendingSend({ run, anchor: true })
    setSentKeys((current) => new Map(current).set(run.triggerMessageId, key))
    setPendingUser((current) =>
      current && current.key === key ? { ...current, messageId: run.triggerMessageId } : current
    )
  }

  /** Run again the turn that never answered. */
  const retry = () => {
    if (threadId === null || !canRetry) return
    if (
      presentation.kind !== "failed" &&
      presentation.kind !== "timeout" &&
      presentation.kind !== "interrupted"
    ) {
      return
    }

    retryRun.mutate(
      { path: { threadId, runId: presentation.run.id } },
      {
        onSuccess: (response) => {
          watchRun(response.run)
          setPendingSend({ run: response.run, anchor: true })
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
      queryClient.invalidateQueries({
        queryKey: listAgentThreadApprovalsQueryKey({ path: { threadId } }),
      }),
    ])

  const keepThreadApprovalMode = async (threadId: string, mode: AgentApprovalMode) => {
    const updated = await saveThreadApprovalMode.mutateAsync({
      path: { threadId },
      body: { approvalMode: mode },
    })
    queryClient.setQueryData(getAgentThreadQueryKey({ path: { threadId } }), updated)
  }

  /**
   * What the reader's next turns here may change without asking. In a thread it is kept as their
   * own choice there, on every device; in a new conversation, until its first message makes one.
   * Either way it becomes their default too, so the next conversation starts where they left off.
   */
  const setApprovalMode = (mode: AgentApprovalMode) => {
    setChosenApprovalMode({ threadId, mode })
    if (mode !== defaultApprovalMode) setDefaultApprovalMode(mode)
    if (threadId === null) return

    // Saves run one after the other: until the last choice is saved, the chip keeps showing it.
    const settle = () =>
      setChosenApprovalMode((current) =>
        current?.threadId === threadId && current.mode === mode ? null : current
      )
    keepThreadApprovalMode(threadId, mode)
      .then(settle)
      .catch(() => {
        settle()
        setSendError({ threadId, failure: "approvalMode" })
      })
  }

  /** The reader's mode in conversations where they chose none, new ones included. */
  const setDefaultApprovalMode = (mode: AgentApprovalMode) => {
    savePreferences.mutate(
      { body: { approvalMode: mode } },
      {
        onSuccess: (preferences) => {
          queryClient.setQueryData(getAgentPreferencesQueryKey(), preferences)
          // The open thread follows the new default unless the reader chose a mode there.
          if (threadId !== null) {
            void queryClient.invalidateQueries({
              queryKey: getAgentThreadQueryKey({ path: { threadId } }),
            })
          }
        },
        onError: () => setSendError({ threadId, failure: "approvalMode" }),
      }
    )
  }

  /**
   * Approve or deny a held call as the reader, who must have asked for its turn. An approved call
   * runs before this resolves, and the card shows how it ended; the decision that settles the
   * turn's last call resumes it, and the conversation follows the new turn under the cards.
   */
  const decide = async (
    approval: AgentApproval,
    decision: AgentApprovalDecision
  ): Promise<AgentApprovalDecided> => {
    try {
      const response = await decideApproval.mutateAsync({
        path: { threadId: approval.threadId, approvalId: approval.id },
        body: decision,
      })
      queryClient.setQueryData<ListAgentThreadApprovalsResponse>(
        listAgentThreadApprovalsOptions({
          path: { threadId: approval.threadId },
          query: THREAD_APPROVALS_QUERY,
        }).queryKey,
        (current) =>
          current && {
            ...current,
            approvals: current.approvals.map((entry) =>
              entry.id === response.approval.id ? response.approval : entry
            ),
          }
      )
      if (response.run) watchRun(response.run)
      if (response.run && response.run.threadId === threadId) {
        setPendingSend({ run: response.run, anchor: false })
      }
      // "Always allow" raised the reader's mode here.
      if (decision.always) setChosenApprovalMode(null)
      return response
    } catch (error) {
      throw new AgentApprovalDecisionError(decisionFailure(error))
    } finally {
      void refreshThread(approval.threadId)
      void queryClient.invalidateQueries({ queryKey: listAgentApprovalsQueryKey() })
    }
  }

  // Sixb writes the continuation for the model, with the cut-short turn's model and reasoning; the
  // transcript shows no message for it.
  const continueTurn = async () => {
    if (isRunning || composerPending || threadId === null || !canContinue) return
    setSendError(null)
    setContinuingThreadId(threadId)
    try {
      const response = await sendWithRequesterSettings((settings) =>
        postMessage.mutateAsync({ path: { threadId }, body: { continue: true, ...settings } })
      )
      setContinuingThreadId(null)
      watchRun(response.run)
      setPendingSend({ run: response.run, anchor: true })
      await refreshThread(threadId)
    } catch (error) {
      setContinuingThreadId(null)
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

  /** Follow the project defaults again, including later changes to them; with tiers, Auto. */
  const resetModelSelection = () => updateModelPreference(null)

  const updateModelPreference = (preference: ModelPreference | null) => {
    if (!tiered) {
      setModelPreference(preference)
      writeModelPreference(preference)
      return
    }

    if (threadId === null) setNewThreadPin(preference)
    else pinModel(threadId, preference)
  }

  // Start from the stored pins, so the ones another tab wrote since are kept.
  const pinModel = (pinThreadId: string, pin: ModelPreference | null) => {
    const pins = withModelPin(readModelPins() ?? modelPins, pinThreadId, pin)
    setModelPins(pins)
    writeModelPins(pins)
  }

  // Leaving a new conversation, or its first message creating the thread, ends its own pin.
  useEffect(() => {
    if (threadId !== null) setNewThreadPin(null)
  }, [threadId])

  // Another tab pinned a model, or went back to Auto.
  useEffect(() => {
    const follow = (event: StorageEvent) => {
      if (event.key === MODEL_PINS_KEY) setModelPins(readModelPins() ?? {})
    }
    window.addEventListener("storage", follow)
    return () => window.removeEventListener("storage", follow)
  }, [])

  const sandboxRecovery =
    thread?.sandboxState &&
    !isRunning &&
    ["busy", "blocked", "unavailable"].includes(thread.sandboxState.status)
      ? thread.sandboxState
      : null

  const listedThreads = [...threads, ...sharedThreads]
  const runningThreadCount =
    listedThreads.filter((entry) => entry.activeRunId !== null).length +
    (threadId &&
    isRunning &&
    !listedThreads.some((entry) => entry.id === threadId && entry.activeRunId !== null)
      ? 1
      : 0)
  const anchorCurrentTurn = Boolean(
    (pendingUser && pendingUser.threadId === threadId) || (pendingRun && pendingSend?.anchor)
  )
  const composerPending = postMessage.isPending || createThread.isPending
  const currentSendError: AgentConversationSendError | null =
    sendError && sendError.threadId === threadId
      ? sendError.failure === "busy"
        ? { code: "busy", someoneElse: requestedBySomeoneElse(activeRun, user) }
        : { code: sendError.failure }
      : null
  const stopping = stoppingRunId !== null && stoppingRunId === activeRunId
  const canStop = isRunning && canStopRun(activeRun, access, user)

  // Someone else's answer holds a shared thread: the composer names whose.
  const answeringFor =
    isRunning && activeRun?.requestedBy && requestedBySomeoneElse(activeRun, user)
      ? activeRun.requestedBy
      : null
  const answeringForName = answeringFor ? knownName(answeringFor, thread, authors) : undefined
  const answeringName = answeringFor ? (answeringForName ?? answeringFor.id) : null

  // A turn that never answered can run again, by whoever asked for it, once the sandbox works.
  const canRetry =
    !sandboxRecovery &&
    (presentation.kind === "failed" ||
      ((presentation.kind === "timeout" || presentation.kind === "interrupted") &&
        !presentation.hasProgress)) &&
    canRetryRun(presentation.run, user)
  const canContinue = offersContinue({
    presentation,
    isRunning,
    sandboxRecovery: Boolean(sandboxRecovery),
    messages: savedMessages,
    latestRun,
  })

  const reader = user
    ? { type: "user" as const, id: user.id, displayName: user.displayName }
    : undefined
  const messages = conversationMessages({
    messages: savedMessages,
    authors,
    thread,
    reader,
    pending: pendingUser && pendingUser.threadId === threadId ? pendingUser : null,
    sentKeys,
    runs,
    live,
    presentation,
  })

  const turn = conversationTurn({
    presentation,
    activeRunId,
    canStop,
    canRetry,
    canContinue,
    stopping,
    retrying: retryRun.isPending,
    continuing: continuingThreadId !== null && continuingThreadId === threadId,
    waitingLonger,
    compacting: live.compacting,
    reconnecting: live.active && reconnecting,
    answeringFor: answeringFor
      ? {
          type: answeringFor.type,
          id: answeringFor.id,
          ...(answeringForName === undefined ? {} : { displayName: answeringForName }),
          isReader: false,
        }
      : null,
  })

  /**
   * Stop a turn paused on held calls, as Stop does a running one: its waiting calls are set aside,
   * and it does not resume. The cards follow from the approval events.
   */
  const stopWaiting = async (approval: AgentApproval) => {
    try {
      await cancelRun.mutateAsync({
        path: { threadId: approval.threadId },
        body: { runId: approval.runId },
      })
    } finally {
      void refreshThread(approval.threadId)
      void queryClient.invalidateQueries({ queryKey: listAgentApprovalsQueryKey() })
    }
  }

  // Every card reads this: it changes with the approvals and the people, not with each stream chunk.
  decideRef.current = decide
  stopRef.current = stopWaiting
  const approvalsLoaded = approvalsQuery.isSuccess
  const transcriptApprovals = useMemo((): TranscriptApprovals => {
    const me = userPrincipal(user)
    return {
      approvals,
      loaded: approvalsLoaded,
      // Without a signed-in user the app acts for the project, which asked for every turn.
      canDecide: (approval) => me === null || samePrincipal(approval.requestedBy, me),
      requesterName: (approval) =>
        knownName(approval.requestedBy, thread, authors) ?? approval.requestedBy.id,
      decide: (approval, decision) => decideRef.current(approval, decision),
      // Whoever asked for the turn, or the thread's owner, as for a running answer.
      canStop: (approval) =>
        me === null ||
        samePrincipal(approval.requestedBy, me) ||
        (thread !== null && samePrincipal(thread.ownerPrincipal, me)),
      stop: (approval) => stopRef.current(approval),
    }
  }, [approvals, approvalsLoaded, user, thread, authors])
  // The newest turn paused on calls the reader decides: the composer says how to move on.
  const awaitingApproval =
    !isRunning &&
    isAwaitingApproval(latestRun) &&
    approvals.some(
      (approval) =>
        approval.status === "pending" &&
        approval.runId === latestRun?.id &&
        transcriptApprovals.canDecide(approval)
    )
  // Any message sets aside the calls still waiting in the thread, whoever asked for them: say so
  // before someone else's request is lost to it.
  const othersWaiting = isRunning
    ? undefined
    : approvals.find(
        (approval) => approval.status === "pending" && !transcriptApprovals.canDecide(approval)
      )

  // Whoever asked for the turn a sub-agent works under, or the thread's owner, stops it.
  const transcriptDelegation = useMemo(
    (): TranscriptDelegation => ({
      canStop: (runId) => canStopRun(runs.find((run) => run.id === runId) ?? null, access, user),
    }),
    [runs, access, user]
  )

  const transcriptProps: TranscriptProps = {
    threadId,
    messages,
    turn,
    anchorCurrentTurn,
    onRetry: canRetry ? retry : undefined,
    onContinue: canContinue ? continueTurn : undefined,
    approvals: transcriptApprovals,
    approvalOutcomes,
    delegation: transcriptDelegation,
  }

  const modelControlsProps = {
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
    modelRouting: modelsQuery.data?.languageRouting,
  }

  const composerProps: ConversationComposerProps = {
    onSend: send,
    error: currentSendError
      ? failureMessage(currentSendError, labels, agentMessages.approvalModes.saveFailed)
      : undefined,
    // Whoever's answer is in flight, the reader writes the next message, and sends it once it ends.
    disabled: Boolean(sandboxRecovery),
    hint: answeringName
      ? agentMessages.sharing.answering(answeringName)
      : othersWaiting
        ? agentMessages.approvals.setsAside(transcriptApprovals.requesterName(othersWaiting))
        : undefined,
    pending: composerPending,
    running: isRunning,
    stopping,
    onStop: canStop ? stop : undefined,
    ...modelControlsProps,
    draft: draftReseed.text,
    draftAttachments: draftReseed.attachments,
    draftContext: draftReseed.context,
    draftNonce: draftReseed.nonce,
    approvalMode,
    onApprovalModeChange: setApprovalMode,
    awaitingApproval,
    dictation: projectDictation(modelsQuery.data),
  }

  const sandboxRecoveryProps: SandboxRecoveryProps | null = sandboxRecovery
    ? {
        pending: recreateSandbox.isPending,
        error: recreateSandbox.isError,
        onRecreate: handleRecreateSandbox,
        canRecreate: access === "owner",
        owner: thread ? personName(threadOwner(thread)) : "",
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
    /**
     * What the next message runs on: `"auto"` with tiers and no model pinned, as Sixb picks each
     * message's model; otherwise the selected model. `resetModelSelection` returns to Auto.
     */
    modelChoice: modelSelection.auto ? ("auto" as const) : selectedModel,
    /** With tiers: a decision model picks each message's model on Auto; without one, `standard`. */
    modelRouting: modelsQuery.data?.languageRouting,
    selectModel,
    selectReasoning,
    resetReasoning,
    resetModelSelection,
    /** Threads with a run in progress, counting this one while its run starts. */
    runningThreadCount,
    threadUnavailable,
    currentAgent,
    currentThread: thread,
    access,
    user,
    removedFromThread,
    /**
     * The conversation, oldest first: its saved messages, the one the reader just sent, and the
     * reply streaming in. Each keeps its `key` once saved.
     */
    messages,
    /** The message page's authors, with their names. */
    authors,
    messagesLoading: threadId !== null && messagesQuery.isLoading,
    messagesError: threadId !== null && messagesQuery.isError ? MESSAGES_LOAD_ERROR : null,
    /** The newest turn: answering, or how it ended, and what the reader may do with it. */
    turn,
    sendError: currentSendError,
    draftReseed,
    composerPending,
    send,
    /** Stop the answer in flight, when `turn.canStop`. */
    stop,
    /** Run again the turn that never answered, when `turn.canRetry`. */
    retry,
    /** Finish the answer cut short, when `turn.canContinue`. */
    continue: continueTurn,
    /** The thread's held calls, oldest first; the transcript shows each as a card. */
    approvals,
    /** Whether the reader decides on a held call: only whoever asked for its turn does. */
    canDecide: transcriptApprovals.canDecide,
    /**
     * Approve or deny a held call. It resolves once decided, the approved call having run; it
     * rejects with an `AgentApprovalDecisionError` when nothing was decided.
     */
    decide,
    /** What the reader's next turns may change without asking; unknown until it loads. */
    approvalMode,
    setApprovalMode,
    /** The threads where a call waits for the reader's decision. */
    waitingThreadIds,
    /** Spread into `<Transcript>`. */
    transcriptProps,
    /** Spread into `<Composer>`, then add the page's own props such as `placeholder`. */
    composerProps,
    /** Spread into `<SandboxRecovery>` while set: the composer stays disabled until it is resolved. */
    sandboxRecoveryProps,
  }
}

/** Why a turn did not start or stop, or the mode did not change. */
type TurnFailure = AgentConversationSendError["code"]

/** Why a decision did not go through. Once the call ran, the decision stands and never throws. */
function decisionFailure(error: unknown): AgentApprovalDecisionFailure {
  if (!isSixbApiError(error)) return "failed"
  if (error.code === "approval_expired") return "expired"
  if (error.code === "approval_not_pending") return "decided"

  return "failed"
}

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
  failure: AgentConversationSendError,
  labels: ReturnType<typeof useAgentMessages>["chat"],
  approvalModeFailed: string
): string {
  switch (failure.code) {
    case "busy":
      return failure.someoneElse ? labels.busyOther : labels.busy
    case "sandbox":
      return labels.sandboxUnavailable
    case "retry":
      return labels.retryFailed
    case "stop":
      return labels.stopFailed
    case "approvalMode":
      return approvalModeFailed
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
    // Files sent alone are the whole message.
    ...(text ? { text } : {}),
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

/** The pins this browser stored, or null when it cannot store any. */
function readModelPins(): Readonly<Record<string, ModelPreference>> | null {
  if (typeof window === "undefined") return null
  try {
    const value = JSON.parse(window.localStorage.getItem(MODEL_PINS_KEY) ?? "null") as unknown
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {}

    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, ModelPreference] =>
          isModelPreference(entry[1]) && entry[1].model !== undefined
      )
    )
  } catch {
    return null
  }
}

/** Set or clear one conversation's pin; a pin set again becomes the most recent. */
function withModelPin(
  pins: Readonly<Record<string, ModelPreference>>,
  key: string,
  pin: ModelPreference | null
): Readonly<Record<string, ModelPreference>> {
  const entries = Object.entries(pins).filter(([entry]) => entry !== key)
  if (pin !== null) entries.push([key, pin])

  return Object.fromEntries(entries.slice(-MAX_MODEL_PINS))
}

function writeModelPins(pins: Readonly<Record<string, ModelPreference>>): void {
  if (typeof window === "undefined") return
  try {
    if (Object.keys(pins).length === 0) window.localStorage.removeItem(MODEL_PINS_KEY)
    else window.localStorage.setItem(MODEL_PINS_KEY, JSON.stringify(pins))
  } catch {
    // Restricted browser contexts may disable storage; the in-memory pins still work.
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

/** The first line of the message, else the first file's name; empty leaves the thread untitled. */
function deriveTitle(text: string, attachments: readonly AgentFileRef[]): string {
  const firstLine = text.split("\n")[0]?.trim() ?? ""
  const title = firstLine || attachments.map((file) => file.fileName?.trim() ?? "").find(Boolean)
  if (!title) return ""

  return title.length <= 60 ? title : `${title.slice(0, 57)}...`
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
