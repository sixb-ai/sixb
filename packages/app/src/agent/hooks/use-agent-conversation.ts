import { isSixbApiError, type ListAgentThreadApprovalsResponse } from "@sixb/client"
import {
  cancelAgentRunMutation,
  createAgentThreadMutation,
  decideAgentApprovalMutation,
  editAgentThreadMessageMutation,
  getAgentOptions,
  getAgentPreferencesOptions,
  getAgentPreferencesQueryKey,
  getAgentThreadContextOptions,
  getAgentThreadContextQueryKey,
  getAgentThreadQueryKey,
  listAgentApprovalsQueryKey,
  listAgentComputersOptions,
  listAgentComputersQueryKey,
  listAgentThreadApprovalsOptions,
  listAgentThreadApprovalsQueryKey,
  listAgentThreadInboxOptions,
  listAgentThreadInboxQueryKey,
  listAgentThreadMessagesQueryKey,
  listAgentThreadRunsQueryKey,
  listAgentThreadsQueryKey,
  listModelsOptions,
  postAgentThreadMessageMutation,
  recreateAgentThreadSandboxMutation,
  restoreAgentThreadSandboxMutation,
  retryAgentRunMutation,
  setAgentThreadApprovalModeMutation,
  stopAgentBackgroundCommandMutation,
  updateAgentPreferencesMutation,
  useAgentActivityStream,
  useDesktop,
  withdrawAgentThreadInboxItemMutation,
} from "@sixb/client/hooks"
import { MODEL_REASONING_LEVELS, type ModelReasoningLevel } from "@sixb/core/models"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
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
import type { TranscriptBackground } from "../background/context"
import type { ComposerProps } from "../components/composer"
import { type ComputerOfflineNoticeProps, folderName } from "../components/computer-place"
import type { PendingMessagesProps } from "../components/pending-messages"
import type { SandboxRecoveryProps } from "../components/sandbox-recovery"
import type { TranscriptProps } from "../components/transcript"
import {
  type AgentConversationTurn,
  conversationMessages,
  conversationTurn,
  type PendingUserMessage,
} from "../conversation"
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
import { transcriptMoves } from "../moves"
import { openQuestion } from "../questions/interpret"
import type { QuestionComposerProps } from "../questions/question-composer"
import { type RequesterSettings, sendWithRequesterSettings } from "../requester-settings"
import {
  CONTEXT_LIMIT_EXCEEDED,
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
import type {
  AgentContextEntryInput,
  AgentContextInput,
  AgentFileRef,
  AgentInboxItem,
  AgentMessageDelivery,
  AgentRun,
  AgentThreadSandboxParams,
  LanguageModel,
} from "../types"
import { markThreadReadsStale, threadQueryOptions } from "./thread-queries"
import {
  ComputerUnavailableError,
  type NewThreadPlaceBody,
  useNewThreadPlace,
} from "./use-new-thread-place"
import { useAgentThreadLists } from "./use-thread-lists"
import { useThreadPlace } from "./use-thread-place"
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
  /**
   * The sandbox the conversation the next message creates works in, as the project's sandbox
   * declares its params, such as a repository and a branch. Such a conversation runs in the cloud,
   * so the composer offers no other place. An open thread keeps the sandbox it was created with.
   */
  readonly newThreadSandbox?: AgentThreadSandboxParams
}

/** The parts of {@link ComposerProps} a conversation decides; the page adds the rest. */
export type ConversationComposerProps = Pick<
  ComposerProps,
  | "onSend"
  | "newThreadPlace"
  | "error"
  | "disabled"
  | "pending"
  | "running"
  | "steerable"
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
  | "draftKey"
  | "draft"
  | "draftAttachments"
  | "draftContext"
  | "draftNonce"
  | "draftReseedKey"
  | "insertion"
  | "onInserted"
  | "approvalMode"
  | "onApprovalModeChange"
  | "awaitingApproval"
  | "dictation"
  | "contextMeter"
>

/** Draft state for an earlier user message open in the inline editor. */
export interface AgentMessageEditDraft {
  readonly messageId: string
  readonly text: string
  readonly attachments: readonly AgentFileRef[]
  readonly context: readonly AgentContextEntryInput[]
  /** Incremented when a failed edit restores this draft, so the editor reseeds. */
  readonly nonce: number
  /** Why the last save did not go through, said under the editor. */
  readonly error?: string
}

export type AgentConversation = ReturnType<typeof useAgentConversation>

/** Why a message, an edit, a retry or a stop did not go through, or the approval mode did not change. */
export type AgentConversationSendError =
  /** Another answer holds the conversation; `someoneElse` when another person asked for it. */
  | { readonly code: "busy"; readonly someoneElse: boolean }
  /** The conversation's sandbox must be recovered before another answer. */
  | { readonly code: "sandbox" }
  /** It's to run on this computer, and what runs it there can't start. */
  | { readonly code: "computer" }
  | { readonly code: "send" | "edit" | "retry" | "stop" | "approvalMode" }

/** The conversation's messages could not be read. */
export interface AgentConversationMessagesError {
  readonly code: "load"
}

const MESSAGES_LOAD_ERROR: AgentConversationMessagesError = { code: "load" }

/** How often an open thread's messages are read again while the activity feed is away. */
const MESSAGES_RECOVERY_POLL_MS = 30_000

/**
 * Everything one conversation with the project's agent needs: its threads, messages, turn and
 * model choice, and the actions on them. Route-independent; the built-in chat and custom chats
 * both render it, by spreading `transcriptProps` and `composerProps` or by drawing `messages` and
 * `turn` themselves.
 */
export function useAgentConversation({
  threadId,
  onThreadCreated,
  newThreadSandbox,
}: UseAgentConversationInput) {
  const agentMessages = useAgentMessages()
  const labels = agentMessages.chat
  const queryClient = useQueryClient()
  const {
    place: newThreadPlace,
    waiting: newThreadPlaceWaiting,
    computerId: desktopComputerId,
    resolveBody: resolvePlaceBody,
  } = useNewThreadPlace(threadId === null)
  const desktopComputer = useDesktop()?.computer
  // Asking for a folder can take as long as the person does: the composer holds meanwhile.
  const [resolvingPlace, setResolvingPlace] = useState(false)
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

      // Another thread may hold reads a prefetch or an earlier visit left: opening it reads again.
      if (event.threadId !== threadId) markThreadReadsStale(queryClient, event.threadId)
      void refreshThreads()
    },
    // A held call changed: its card, and the thread list's count of what waits for the reader. Its
    // turn's runs follow from their own events.
    onApprovalActivity: (event) => void refreshApprovals(event.threadId),
    // The reader's sixb opened or closed in a folder: the places a new conversation can run follow,
    // and so does the open conversation's badge, should it run there. So do its background
    // commands, which may run where it ran before it moved.
    onComputerActivity: (event) => {
      void queryClient.invalidateQueries({ queryKey: listAgentComputersQueryKey() })
      const place = thread?.computer
      const here = place?.id === event.computerId && place.folder === event.folder
      if (threadId && (here || thread?.backgroundCommands)) void refreshThread(threadId)
    },
    // It moved from another tab or from sixb: the badge and notice follow.
    onThreadMoved: (event) => {
      if (event.threadId === threadId) void refreshThread(threadId)
    },
    // On every (re)subscription: catch up with what changed while the socket was away.
    onSubscribed: () => {
      markThreadReadsStale(queryClient)
      void queryClient.invalidateQueries({ queryKey: listAgentApprovalsQueryKey() })
      void queryClient.invalidateQueries({ queryKey: listAgentComputersQueryKey() })
      void (threadId === null ? refreshThreads() : refreshThread(threadId))
    },
  })

  // The project activity feed is primary. Poll only as a focus-aware recovery path while the
  // socket is unavailable, rather than opening one connection per background thread.
  const recoveryPollMs = !activityStream.connected || activityStream.error ? 10_000 : false
  // A thread's messages are its heaviest read, so they follow less often while the feed is away;
  // its runs and the thread still poll at the faster rate.
  const messagesRecoveryPollMs = recoveryPollMs === false ? false : MESSAGES_RECOVERY_POLL_MS
  const { threads, sharedThreads, waitingThreadIds } = useAgentThreadLists({
    refetchInterval: recoveryPollMs,
  })
  const currentAgent = agentQuery.data
  const models = useMemo(() => modelsQuery.data?.language ?? [], [modelsQuery.data])
  // The browser remembers one choice: a new conversation starts on it, and with tiers each
  // conversation keeps the model pinned in it. Without tiers, that one choice serves every
  // conversation.
  const tiered = hasTiers(models)
  const [modelPreference, setModelPreference] = useState(readModelPreference)
  const [modelPins, setModelPins] = useState(() => readModelPins() ?? {})
  const modelSelection = resolveModelSelection(
    models,
    tiered ? (threadId === null ? modelPreference : (modelPins[threadId] ?? null)) : modelPreference
  )
  const selectedModel = modelSelection.model
  const selectedReasoning = modelSelection.reasoning
  const reads = threadQueryOptions(threadId ?? "")
  const threadQuery = useQuery({
    ...reads.thread,
    enabled: threadId !== null,
    refetchInterval: recoveryPollMs,
    // A shared thread can lose its reader without an event, and a computer's sixb can stop
    // without saying so: read it again when they come back, however recent the last read.
    refetchOnWindowFocus: (query) =>
      isShared(query.state.data ?? null) || query.state.data?.computer !== undefined
        ? "always"
        : false,
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
  // The reader's own conversation on their computer, with no sixb open in its folder: a message
  // waits for it, or the conversation moves to the cloud.
  const computerOffline =
    access === "owner" && thread?.runsOn === "computer" && thread.computer?.online !== true

  const messagesQuery = useQuery({
    ...reads.messages,
    enabled: threadId !== null,
    refetchInterval: messagesRecoveryPollMs,
  })
  const savedMessages = useMemo(() => messagesQuery.data?.messages ?? [], [messagesQuery.data])
  const approvalOutcomes = useMemo(() => reportedApprovalOutcomes(savedMessages), [savedMessages])
  const authors = messagesQuery.data?.authors
  // Every run, as every message is read: the transcript marks each move from the runs either side.
  const runsQuery = useQuery({
    ...reads.runs,
    enabled: threadId !== null,
    refetchInterval: recoveryPollMs,
  })
  const runs = useMemo(() => runsQuery.data?.runs ?? [], [runsQuery.data])
  const latestRun = runs[0] ?? null

  // An edit the reader saved while a turn answered waits in the thread's inbox until that turn
  // ends: read from there, it stands in place after a reload, and on another device.
  const inboxQuery = useQuery({
    ...listAgentThreadInboxOptions({ path: { threadId: threadId ?? "" } }),
    enabled: threadId !== null,
    refetchInterval: (query) => ((query.state.data?.items.length ?? 0) > 0 ? 5_000 : false),
  })
  const waitingEdit = useMemo(
    () =>
      inboxQuery.data?.items.find(
        (item) =>
          item.replacesMessageId !== undefined &&
          (!user || (item.authorPrincipal.type === "user" && item.authorPrincipal.id === user.id))
      ) ?? null,
    [inboxQuery.data, user]
  )

  // Measured against the model the next message goes to; on Auto, the latest turn's.
  const meteredModel = modelSelection.auto ? undefined : selectedModel
  const contextQuery = useQuery({
    ...getAgentThreadContextOptions({
      path: { threadId: threadId ?? "" },
      query: meteredModel ? { provider: meteredModel.provider, modelId: meteredModel.modelId } : {},
    }),
    enabled: threadId !== null,
    // Turns and compactions invalidate it; nothing else changes it.
    staleTime: 5 * 60_000,
    // Another model's limits keep the meter in place until they arrive; another thread's never do.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[0].path.threadId === threadId ? previous : undefined,
    // A meter that cannot be read is left out: it never stands in the way of the conversation.
    retry: false,
  })

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
  const [editingMessage, setEditingMessage] = useState<AgentMessageEditDraft | null>(null)
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
    /** The conversation the message was for, whichever one is open when it comes back. */
    draftKey: string
  }>({ text: "", attachments: [], context: [], nonce: 0, draftKey: "draft" })
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
  /** The thread whose sandbox its owner just resumed, until its cut-short turn runs again. */
  const [resumedThreadId, setResumedThreadId] = useState<string | null>(null)

  const pendingRun =
    pendingSend && threadId !== null && pendingSend.run.threadId === threadId
      ? pendingSend.run
      : null
  const activeRunId =
    threadId !== null
      ? selectActiveRunId({ pendingRun, threadActiveRunId: thread?.activeRunId ?? null, latestRun })
      : null
  const { live, run: streamRun, reconnecting } = useThreadStream({ threadId, runId: activeRunId })
  // What the turn read as it answered leaves the tray: the transcript shows it where it was read.
  const readMessageIds = useMemo(
    () => new Set(live.inboxReads.flatMap((read) => read.messages.map((message) => message.id))),
    [live.inboxReads]
  )
  // A compaction that ended changed what the conversation weighs: measure it again.
  const wasCompactingRef = useRef(false)
  useEffect(() => {
    const ended = wasCompactingRef.current && !live.compacting
    wasCompactingRef.current = live.compacting
    if (!ended || threadId === null) return

    void queryClient.invalidateQueries({
      queryKey: getAgentThreadContextQueryKey({ path: { threadId } }),
    })
  }, [live.compacting, threadId, queryClient])
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
    const replacedGone =
      pendingUser.replacesMessageId === undefined ||
      !savedMessages.some((message) => message.id === pendingUser.replacesMessageId)
    if (
      pendingUser.messageId &&
      replacedGone &&
      savedMessages.some((message) => message.id === pendingUser.messageId)
    ) {
      setPendingUser(null)
    }
  }, [pendingUser, threadId, savedMessages])

  useEffect(() => {
    if (threadId === null || !waitingEdit) return
    setPendingUser((current) =>
      current?.threadId === threadId ? current : waitingEditPending(threadId, waitingEdit)
    )
  }, [threadId, waitingEdit])

  // An edit that waited and never became a message was set aside: withdrawn, or dropped once the
  // message it replaced was gone. The conversation shows what the thread holds again.
  useEffect(() => {
    if (!pendingUser?.replacesMessageId || pendingUser.messageId === null) return
    if (pendingUser.threadId !== threadId || pendingSend !== null) return
    if (!inboxQuery.isSuccess || inboxQuery.isFetching || messagesQuery.isFetching) return

    const waiting = inboxQuery.data.items.some((item) => item.messageId === pendingUser.messageId)
    const saved = savedMessages.some((message) => message.id === pendingUser.messageId)
    if (!waiting && !saved && activeRunId === null) setPendingUser(null)
  }, [
    pendingUser,
    threadId,
    pendingSend,
    inboxQuery.isSuccess,
    inboxQuery.isFetching,
    inboxQuery.data,
    messagesQuery.isFetching,
    savedMessages,
    activeRunId,
  ])

  useEffect(() => {
    setSendError((current) => (current && current.threadId === threadId ? current : null))
    setEditingMessage(null)
  }, [threadId])

  const createThread = useMutation(createAgentThreadMutation())
  const postMessage = useMutation(postAgentThreadMessageMutation())
  const editThreadMessage = useMutation(editAgentThreadMessageMutation())
  const withdrawInboxItem = useMutation(withdrawAgentThreadInboxItemMutation())
  const cancelRun = useMutation(cancelAgentRunMutation())
  const retryRun = useMutation(retryAgentRunMutation())
  const recreateSandbox = useMutation(recreateAgentThreadSandboxMutation())
  const restoreSandbox = useMutation(restoreAgentThreadSandboxMutation())
  const stopBackgroundCommand = useMutation(stopAgentBackgroundCommandMutation())
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

  const activePending = pendingUser && pendingUser.threadId === threadId ? pendingUser : null
  const visibleSavedMessages = useMemo(() => {
    if (!activePending?.replacesMessageId) return savedMessages
    const cut = savedMessages.findIndex((entry) => entry.id === activePending.replacesMessageId)
    return cut === -1 ? savedMessages : savedMessages.slice(0, cut)
  }, [activePending?.replacesMessageId, savedMessages])

  // From Save until the thread holds the edited message: the turns it replaces, and any turn it
  // stopped, are gone from the transcript.
  const editInFlight = activePending?.replacesMessageId !== undefined
  const basePresentation = presentActiveTurn({
    activeRunId: editInFlight ? null : activeRunId,
    pendingRun,
    streamRun: editInFlight ? null : streamRun,
    live,
    runs,
    messages: visibleSavedMessages,
    messagesLoading: messagesQuery.isFetching,
  })
  const presentation = editInFlight
    ? ({ kind: "responding", queuedRun: null } as const)
    : basePresentation
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
    if (threadId === null) return
    // While an edit waits for the turn it stopped, Stop takes the edit back, to the editor.
    if (waitingEdit && pendingUser?.messageId === waitingEdit.messageId) {
      withdrawEdit(threadId, waitingEdit)
      return
    }
    if (activeRunId === null || !canStop) return
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

  const withdrawEdit = (targetThreadId: string, item: AgentInboxItem) => {
    const edit = pendingUser
    withdrawInboxItem.mutate(
      { path: { threadId: targetThreadId, itemId: item.id } },
      {
        onSuccess: () => {
          setPendingUser(null)
          // The turn the edit stopped is still winding down: it shows as stopping.
          if (activeRunId !== null) setStoppingRunId(activeRunId)
          if (edit?.replacesMessageId) {
            setEditingMessage((current) => ({
              messageId: edit.replacesMessageId as string,
              text: edit.text,
              attachments: edit.attachments,
              context: edit.context,
              nonce: (current?.nonce ?? 0) + 1,
            }))
          }
        },
        // A turn already started from it: Stop again stops that turn.
        onSettled: () => void refreshThread(targetThreadId),
      }
    )
  }

  // The turn runs in the mode the chip shows, whatever another device chose since.
  const turnApprovalMode = approvalMode === undefined ? {} : { approvalMode }

  const send = async (
    text: string,
    attachments: readonly AgentFileRef[],
    context: readonly AgentContextEntryInput[],
    delivery: AgentMessageDelivery = "auto"
  ) => {
    // A running turn takes the message as a steer, a queued turn, or one that stops it. A chat that
    // does not say where it goes sends it where Enter would: into the reader's own answer, or after
    // the answer in flight when it is someone else's or carries a file, which no step reads.
    // The thread that a message starts is always a turn, whatever the composer said.
    const where: AgentMessageDelivery =
      isRunning && delivery === "auto"
        ? attachments.length === 0 && !requestedBySomeoneElse(activeRun, user)
          ? "steer"
          : "queue"
        : delivery
    setSendError(null)
    const targetThreadId = threadId
    // What this message asks for, and what the thread it creates keeps pinned.
    const selection = modelSelection.request
    const key = `sent:${++sentMessageCount}`
    let createdThreadId: string | null = null
    try {
      if (targetThreadId !== null) {
        // A message for the running turn waits in the inbox, which the tray shows: only one that
        // starts a turn is the transcript's next message.
        if (where === "auto") {
          setPendingUser({
            key,
            threadId: targetThreadId,
            text,
            attachments,
            context,
            messageId: null,
          })
        }
        const response = await sendWithRequesterSettings((settings) =>
          postMessage.mutateAsync({
            path: { threadId: targetThreadId },
            body: {
              ...messageBody(text, attachments, context, selection, settings),
              ...turnApprovalMode,
              ...(where === "auto" ? {} : { delivery: where }),
            },
          })
        )
        if (response.run) recordAcceptedSend(response.run, key)
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: listAgentThreadMessagesQueryKey({ path: { threadId: targetThreadId } }),
          }),
          queryClient.invalidateQueries({ queryKey: listAgentThreadsQueryKey() }),
          // A message that waits beside the running turn is in the thread's inbox, not its
          // transcript: the tray reads it from there.
          queryClient.invalidateQueries({
            queryKey: listAgentThreadInboxQueryKey({ path: { threadId: targetThreadId } }),
          }),
        ])
        return
      }

      if (!currentAgent) return
      // A conversation with a sandbox runs in the cloud: there is no folder to ask for.
      const sandbox = newThreadSandbox
      let place: NewThreadPlaceBody | null = {}
      if (!sandbox) {
        setResolvingPlace(true)
        place = await resolvePlaceBody().finally(() => setResolvingPlace(false))
      }
      if (!place) {
        // They cancelled choosing a folder: nothing was sent, and their message goes back.
        setDraftReseed((current) => ({
          text,
          attachments,
          context,
          nonce: current.nonce + 1,
          draftKey: "draft",
        }))
        return
      }
      const title = deriveTitle(text, attachments)
      const created = await createThread.mutateAsync({
        body: { ...(title ? { title } : {}), ...place, ...(sandbox ? { sandbox } : {}) },
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
            ...messageBody(text, attachments, context, selection, settings),
            ...turnApprovalMode,
          },
        })
      )
      if (response.run) recordAcceptedSend(response.run, key)
      // The next new conversation starts from the default again.
      setChosenApprovalMode((current) => (current?.threadId === null ? null : current))
      await queryClient.invalidateQueries({ queryKey: listAgentThreadsQueryKey() })
      showCreatedThread(createdThreadId, selection)
    } catch (error) {
      // Restore the exact submitted snapshot. In particular, do not re-read ambient page context:
      // navigation may have changed it while the request was in flight.
      setPendingUser(null)
      setDraftReseed((current) => ({
        text,
        attachments,
        context,
        nonce: current.nonce + 1,
        draftKey: createdThreadId ?? targetThreadId ?? "draft",
      }))
      setSendError({
        threadId: createdThreadId ?? targetThreadId,
        failure: sendFailure(error),
      })
      if (createdThreadId) showCreatedThread(createdThreadId, selection)

      // A refusal can mean another turn holds the thread: read who asked for it, too.
      if (targetThreadId !== null) void refreshThread(targetThreadId)
      else void queryClient.invalidateQueries({ queryKey: listAgentThreadsQueryKey() })
    }
  }

  // The model the first message ran on is pinned in the thread it created, from the moment it shows.
  const showCreatedThread = (createdThreadId: string, pin: ModelPreference | undefined) => {
    if (tiered && pin) pinModel(createdThreadId, pin)
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
      queryClient.invalidateQueries({
        queryKey: getAgentThreadContextQueryKey({ path: { threadId } }),
      }),
      // A turn that ended read its steers, or started what was queued behind it.
      queryClient.invalidateQueries({
        queryKey: listAgentThreadInboxQueryKey({ path: { threadId } }),
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
      if (response.run) {
        watchRun(response.run)
        setPendingSend({ run: response.run, anchor: true })
      }
      await refreshThread(threadId)
    } catch (error) {
      setContinuingThreadId(null)
      setSendError({ threadId, failure: sendFailure(error) })
      void refreshThread(threadId)
    }
  }

  /** Recover the thread's sandbox as its owner chose: fresh, or as the failed save left it. */
  const recoverSandbox = (recovery: typeof recreateSandbox | typeof restoreSandbox) => {
    if (!thread?.sandboxState || isRunning || access !== "owner") return
    recovery.mutate(
      {
        path: { threadId: thread.id },
        body: { expectedSandboxName: thread.sandboxState.name },
      },
      {
        onSuccess: () => {
          if (recovery === restoreSandbox) setResumedThreadId(thread.id)

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

  /** The reader's choice: what a new conversation starts on, and the model pinned in this thread. */
  const updateModelPreference = (preference: ModelPreference | null) => {
    setModelPreference(preference)
    writeModelPreference(preference)
    if (tiered && threadId !== null) pinModel(threadId, preference)
  }

  // Start from the stored pins, so the ones another tab wrote since are kept.
  const pinModel = (pinThreadId: string, pin: ModelPreference | null) => {
    const pins = withModelPin(readModelPins() ?? modelPins, pinThreadId, pin)
    setModelPins(pins)
    writeModelPins(pins)
  }

  // Another tab chose a model, pinned one, or went back to Auto.
  useEffect(() => {
    const follow = (event: StorageEvent) => {
      if (event.key === MODEL_PINS_KEY) setModelPins(readModelPins() ?? {})
      if (event.key === MODEL_PREFERENCE_KEY) setModelPreference(readModelPreference())
    }
    window.addEventListener("storage", follow)
    return () => window.removeEventListener("storage", follow)
  }, [])

  const sandboxRecovery =
    thread?.runsOn !== "computer" &&
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
  const composerPending =
    postMessage.isPending || editThreadMessage.isPending || createThread.isPending || resolvingPlace
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

  // A turn that never answered can run again, by whoever asked for it, once the sandbox works,
  // unless it would fail the same way: a conversation too long for its model.
  const canRetry =
    !(access === "participant" && thread?.runsOn === "computer") &&
    !sandboxRecovery &&
    ((presentation.kind === "failed" && presentation.run.error?.code !== CONTEXT_LIMIT_EXCEEDED) ||
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

  // Resuming the sandbox picks the cut-short turn up again, once the thread reads ready: it goes
  // on where it stopped, or runs again when it had not got anywhere.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Continue and Retry check their own state
  useEffect(() => {
    if (resumedThreadId === null) return
    if (resumedThreadId !== threadId) {
      setResumedThreadId(null)
      return
    }
    if (sandboxRecovery) return

    setResumedThreadId(null)
    if (canContinue) void continueTurn()
    else if (canRetry) retry()
  }, [resumedThreadId, threadId, sandboxRecovery, canContinue, canRetry])

  const reader = user
    ? { type: "user" as const, id: user.id, displayName: user.displayName }
    : undefined
  const messages = conversationMessages({
    messages: savedMessages,
    authors,
    thread,
    reader,
    pending: activePending,
    sentKeys,
    runs,
    live,
    presentation,
  })

  const editableMessageIds = useMemo((): ReadonlySet<string> => {
    if (
      threadId === null ||
      sandboxRecovery ||
      editInFlight ||
      (thread?.runsOn === "computer" && access !== "owner") ||
      (isRunning && !canStop)
    ) {
      return new Set()
    }
    // An edit takes back whole turns: a message a turn read while it answered, as a steer, sits
    // inside that turn, which started at an earlier message.
    const indexOf = new Map(messages.map((entry, index) => [entry.id, index]))
    const turnStart = new Map(runs.map((run) => [run.id, indexOf.get(run.triggerMessageId)]))
    let earliestTurnAfter = Number.POSITIVE_INFINITY

    const allowed = new Set<string>()
    let seenOtherUser = false
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const entry = messages[index]
      if (!entry) continue

      if (entry.role === "assistant" && entry.runId !== null) {
        const start = turnStart.get(entry.runId)
        if (start !== undefined) earliestTurnAfter = Math.min(earliestTurnAfter, start)
      }
      if (entry.role !== "user") continue

      const ownMessage = !user || !entry.author || entry.author.isReader
      const insideTurn = earliestTurnAfter < index
      if (
        entry.id !== null &&
        entry.status === "complete" &&
        ownMessage &&
        !insideTurn &&
        (access === "owner" || !seenOtherUser)
      ) {
        allowed.add(entry.id)
      }
      if (!ownMessage) seenOtherUser = true
    }
    return allowed
  }, [
    threadId,
    sandboxRecovery,
    editInFlight,
    thread?.runsOn,
    access,
    isRunning,
    canStop,
    messages,
    runs,
    user,
  ])

  const startEditMessage = useCallback(
    (messageId: string) => {
      if (!editableMessageIds.has(messageId)) return
      const target = messages.find((entry) => entry.id === messageId && entry.role === "user")
      if (!target) return
      const text = target.parts
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("")
        .trim()
      const attachments = target.parts.flatMap((part) =>
        part.type === "file" ? [part.fileRef] : []
      )
      setEditingMessage((current) => ({
        messageId,
        text,
        attachments,
        context: target.context,
        nonce: (current?.nonce ?? 0) + 1,
      }))
    },
    [editableMessageIds, messages]
  )

  const cancelEditMessage = useCallback(() => {
    setEditingMessage(null)
  }, [])

  /**
   * Replace an earlier message and take the conversation back to it. A turn still answering stops
   * first: the server holds the edit until that turn ends, then rewinds. Meanwhile the transcript
   * shows the edit in place of the message, with the turns after it gone.
   */
  const editMessage = async (
    messageId: string,
    text: string,
    attachments: readonly AgentFileRef[],
    context: readonly AgentContextEntryInput[]
  ) => {
    const targetThreadId = threadId
    if (targetThreadId === null || !editableMessageIds.has(messageId)) return

    setSendError(null)
    setEditingMessage(null)
    const key =
      messages.find((entry) => entry.id === messageId)?.key ?? `sent:${++sentMessageCount}`
    setPendingUser({
      key,
      threadId: targetThreadId,
      text,
      attachments,
      context,
      messageId: null,
      replacesMessageId: messageId,
    })

    try {
      const response = await sendWithRequesterSettings((settings) =>
        editThreadMessage.mutateAsync({
          path: { threadId: targetThreadId, messageId },
          body: {
            ...messageBody(text, attachments, context, modelSelection.request, settings),
            ...turnApprovalMode,
          },
        })
      )

      if (response.run) {
        recordAcceptedSend(response.run, key)
      } else if (response.item) {
        // It waits for the turn it stopped: its message takes this id once that turn ends.
        const waitingId = response.item.messageId
        setPendingUser((current) =>
          current && current.key === key ? { ...current, messageId: waitingId } : current
        )
      }
      await refreshThread(targetThreadId)
    } catch (error) {
      setPendingUser(null)
      setEditingMessage((current) => ({
        messageId,
        text,
        attachments,
        context,
        nonce: (current?.nonce ?? 0) + 1,
        error: editFailureMessage(
          editFailure(error),
          requestedBySomeoneElse(activeRun, user),
          labels
        ),
      }))
      void refreshThread(targetThreadId)
    }
  }

  const answeringAuthor = useMemo(
    () =>
      answeringFor
        ? {
            type: answeringFor.type,
            id: answeringFor.id,
            ...(answeringForName === undefined ? {} : { displayName: answeringForName }),
            isReader: false,
          }
        : null,
    [answeringFor, answeringForName]
  )
  const continuingHere = continuingThreadId !== null && continuingThreadId === threadId
  const waitingForComputer =
    computerOffline && thread?.computer
      ? agentMessages.computer.placeOn(folderName(thread.computer.folder), thread.computer.name)
      : null
  const streamReconnecting = live.active && reconnecting
  const nextTurn = conversationTurn({
    presentation,
    activeRunId,
    canStop,
    canRetry,
    canContinue,
    stopping,
    retrying: retryRun.isPending,
    continuing: continuingHere,
    waitingLonger,
    waitingFor: waitingForComputer,
    compacting: live.compacting,
    contextFull: live.contextFull,
    reconnecting: streamReconnecting,
    answeringFor: answeringAuthor,
  })
  const prevTurnRef = useRef(nextTurn)
  if (!sameTurn(prevTurnRef.current, nextTurn)) prevTurnRef.current = nextTurn
  const turn = prevTurnRef.current

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

  // The names of the reader's computers, where they're already known: a run keeps only the id.
  const listedComputers = useQuery({ ...listAgentComputersOptions(), enabled: false }).data
  const computerNames = useMemo(() => {
    const names = new Map(
      (listedComputers?.computers ?? []).map((computer) => [computer.id, computer.name])
    )
    if (thread?.computer) names.set(thread.computer.id, thread.computer.name)
    return names
  }, [listedComputers, thread?.computer])

  // Where the conversation moved, at every turn that ran elsewhere than the one before and where it
  // runs now: the files earlier turns worked on stayed behind.
  const { moved, moves } = useMemo(
    () =>
      transcriptMoves({
        thread,
        savedMessages,
        shownIds: new Set(messages.flatMap((message) => (message.id !== null ? [message.id] : []))),
        runs,
        messages: agentMessages.computer,
        computerNames,
        ownerName: thread && access === "participant" ? personName(threadOwner(thread)) : null,
      }),
    [access, agentMessages.computer, computerNames, messages, runs, savedMessages, thread]
  )

  const hasPendingApprovals =
    isAwaitingApproval(latestRun) &&
    approvals.some((approval) => approval.status === "pending" && approval.runId === latestRun?.id)
  // A computer's conversation moves with a turn still queued for it; the cloud's, once none is.
  const replyRunning = thread?.runsOn === "computer" ? activeRun?.status === "running" : isRunning
  const placeBusy = hasPendingApprovals ? "approval" : replyRunning ? "running" : null
  const messageWaiting = thread?.runsOn === "computer" && activeRun?.status === "queued"
  const place = useThreadPlace({ thread, access, busy: placeBusy, waiting: messageWaiting })

  // Its background commands: what its owner's sixb reports of them, and their Stop, to its owner
  // alone, as the computer is theirs. A command started in a folder runs on there once the thread
  // moved to another, or to the cloud.
  const computer = thread?.computer
  const backgroundCommands = thread?.backgroundCommands
  const runsOnComputer = thread?.runsOn === "computer"
  // biome-ignore lint/correctness/useExhaustiveDependencies: the mutation and the refresh are the conversation's
  const transcriptBackground = useMemo((): TranscriptBackground => {
    const live = backgroundCommands ?? (computer ? [] : null)
    return {
      source: { onComputer: runsOnComputer, live, online: computer?.online ?? false },
      ...(live !== null && threadId !== null
        ? {
            stop: async (command) => {
              await stopBackgroundCommand.mutateAsync({
                path: { threadId, commandId: command.id },
                body: { startedAt: command.startedAt },
              })
              await refreshThread(threadId)
            },
          }
        : {}),
    }
  }, [computer, backgroundCommands, runsOnComputer, threadId])

  // The Agent's open question takes the composer's place until it is answered or set aside, to
  // reply in words of one's own.
  const [questionSetAside, setQuestionSetAside] = useState<string | null>(null)
  const asked = threadId !== null ? openQuestion(messages, turn) : null
  const asking = asked !== null && questionSetAside !== asked.messageKey ? asked : null
  // Stable callbacks so streaming chunks never invalidate memoized Composer or Transcript controls.
  const actionsRef = useRef({
    send,
    stop,
    retry,
    continueTurn,
    selectModel,
    selectReasoning,
    resetReasoning,
    resetModelSelection,
    setApprovalMode,
    editMessage,
  })
  actionsRef.current = {
    send,
    stop,
    retry,
    continueTurn,
    selectModel,
    selectReasoning,
    resetReasoning,
    resetModelSelection,
    setApprovalMode,
    editMessage,
  }
  const stableSend = useCallback<ComposerProps["onSend"]>(
    (text, attachments, context, delivery) =>
      void actionsRef.current.send(text, attachments, context, delivery),
    []
  )
  const stableStop = useCallback(() => actionsRef.current.stop(), [])
  const stableRetry = useCallback(() => actionsRef.current.retry(), [])
  const stableContinue = useCallback(() => void actionsRef.current.continueTurn(), [])
  const stableSelectModel = useCallback(
    (model: LanguageModel) => actionsRef.current.selectModel(model),
    []
  )
  const stableSelectReasoning = useCallback(
    (reasoning: ModelReasoningLevel) => actionsRef.current.selectReasoning(reasoning),
    []
  )
  const stableResetReasoning = useCallback(() => actionsRef.current.resetReasoning(), [])
  const stableResetModelSelection = useCallback(() => actionsRef.current.resetModelSelection(), [])
  const stableSetApprovalMode = useCallback(
    (mode: AgentApprovalMode) => actionsRef.current.setApprovalMode(mode),
    []
  )
  const stableSubmitEdit = useCallback<NonNullable<TranscriptProps["onSubmitEditMessage"]>>(
    (messageId, text, attachments, context) =>
      void actionsRef.current.editMessage(messageId, text, attachments, context),
    []
  )
  const stableAnswerQuestion = useCallback(
    (text: string) => void actionsRef.current.send(text, [], []),
    []
  )

  const askingKey = asking?.messageKey ?? null
  const dismissQuestion = useCallback(() => {
    if (askingKey) setQuestionSetAside(askingKey)
  }, [askingKey])

  const questionProps: QuestionComposerProps | null = useMemo(
    () =>
      asking
        ? {
            questions: asking.questions,
            onAnswer: stableAnswerQuestion,
            onDismiss: dismissQuestion,
          }
        : null,
    [asking, stableAnswerQuestion, dismissQuestion]
  )

  const movedAfterMessageId = moved?.afterMessageId ?? null
  const movedLabel = moved?.label ?? null
  const stableMoved = useMemo(
    () =>
      movedAfterMessageId && movedLabel
        ? { afterMessageId: movedAfterMessageId, label: movedLabel }
        : null,
    [movedAfterMessageId, movedLabel]
  )

  const transcriptProps: TranscriptProps = useMemo(
    () => ({
      threadId,
      messages,
      moved: stableMoved,
      moves,
      turn,
      anchorCurrentTurn,
      onRetry: canRetry ? stableRetry : undefined,
      onContinue: canContinue ? stableContinue : undefined,
      editableMessageIds,
      editingMessage,
      onStartEditMessage: startEditMessage,
      onCancelEditMessage: cancelEditMessage,
      onSubmitEditMessage: stableSubmitEdit,
      approvals: transcriptApprovals,
      approvalOutcomes,
      delegation: transcriptDelegation,
      background: transcriptBackground,
    }),
    [
      threadId,
      messages,
      stableMoved,
      moves,
      turn,
      anchorCurrentTurn,
      canRetry,
      stableRetry,
      canContinue,
      stableContinue,
      editableMessageIds,
      editingMessage,
      startEditMessage,
      cancelEditMessage,
      stableSubmitEdit,
      transcriptApprovals,
      approvalOutcomes,
      transcriptDelegation,
      transcriptBackground,
    ]
  )

  const meterContext = threadId !== null ? contextQuery.data : undefined
  const meterModelName = meteredModelName(models, contextQuery.data?.model)
  const contextMeter = useMemo(
    () => ({
      context: meterContext,
      modelName: meterModelName,
      condensing: live.compacting,
    }),
    [meterContext, meterModelName, live.compacting]
  )

  const composerError = currentSendError
    ? failureMessage(currentSendError, labels, agentMessages.approvalModes.saveFailed)
    : undefined
  const composerHint = answeringName
    ? agentMessages.sharing.answering(answeringName)
    : othersWaiting
      ? agentMessages.approvals.setsAside(transcriptApprovals.requesterName(othersWaiting))
      : undefined
  const resolvedNewThreadPlace =
    threadId === null && !newThreadSandbox && (newThreadPlace || newThreadPlaceWaiting)
      ? (newThreadPlace ?? "waiting")
      : undefined
  const usingDefaultModel = modelSelection.request === undefined
  const modelRouting = modelsQuery.data?.languageRouting
  const dictationRecognizer = projectDictation(modelsQuery.data)
  const composerDisabled = Boolean(sandboxRecovery)
  const steerable = !requestedBySomeoneElse(activeRun, user)

  const composerProps: ConversationComposerProps = useMemo(
    () => ({
      onSend: stableSend,
      ...(resolvedNewThreadPlace ? { newThreadPlace: resolvedNewThreadPlace } : {}),
      error: composerError,
      // Whoever's answer is in flight, the reader writes the next message.
      disabled: composerDisabled,
      hint: composerHint,
      pending: composerPending,
      running: isRunning,
      // Only the turn the reader asked for takes a steer; another person's takes a queued message.
      steerable,
      stopping,
      onStop: canStop ? stableStop : undefined,
      models,
      selectedModel,
      selectedReasoning,
      modelsLoading: modelsQuery.isLoading,
      modelsError: modelsQuery.isError,
      onSelectModel: stableSelectModel,
      onSelectReasoning: stableSelectReasoning,
      onResetReasoning: stableResetReasoning,
      usingDefaultModel,
      onResetModelSelection: stableResetModelSelection,
      modelRouting,
      draftKey: threadId ?? "draft",
      draft: draftReseed.text,
      draftAttachments: draftReseed.attachments,
      draftContext: draftReseed.context,
      draftNonce: draftReseed.nonce,
      draftReseedKey: draftReseed.draftKey,
      approvalMode,
      onApprovalModeChange: stableSetApprovalMode,
      awaitingApproval,
      dictation: dictationRecognizer,
      contextMeter,
    }),
    [
      stableSend,
      resolvedNewThreadPlace,
      composerError,
      composerDisabled,
      composerHint,
      composerPending,
      isRunning,
      steerable,
      stopping,
      canStop,
      stableStop,
      models,
      selectedModel,
      selectedReasoning,
      modelsQuery.isLoading,
      modelsQuery.isError,
      stableSelectModel,
      stableSelectReasoning,
      stableResetReasoning,
      usingDefaultModel,
      stableResetModelSelection,
      modelRouting,
      threadId,
      draftReseed,
      approvalMode,
      stableSetApprovalMode,
      awaitingApproval,
      dictationRecognizer,
      contextMeter,
    ]
  )

  const pendingProps: PendingMessagesProps = useMemo(
    () => ({ threadId, steerable, read: readMessageIds }),
    [threadId, steerable, readMessageIds]
  )

  // The header's move to the cloud, from the notice: one move, one state, wherever it's asked.
  const computerNoticeProps: ComputerOfflineNoticeProps | null =
    computerOffline && place
      ? {
          computer: thread?.computer ?? null,
          waiting: messageWaiting,
          pending: place.movingTo === "cloud",
          moving: place.pending,
          busy: place.busy,
          error: place.cloudError,
          onContinueInCloud: place.moveToCloud,
          ...(desktopComputer && thread?.computer && thread.computer.id === desktopComputerId
            ? {
                onRunHere: () =>
                  void desktopComputer.allowFolder(thread.computer?.folder ?? "").catch(() => {}),
              }
            : {}),
        }
      : null

  const sandboxRecoveryProps: SandboxRecoveryProps | null = sandboxRecovery
    ? {
        pending: recreateSandbox.isPending || restoreSandbox.isPending,
        error: recreateSandbox.isError,
        onRecreate: () => recoverSandbox(recreateSandbox),
        // Only a workspace its run finished preparing has files to go on from.
        ...(sandboxRecovery.status !== "unavailable" && sandboxRecovery.initialized
          ? {
              restore: {
                pending: restoreSandbox.isPending,
                error: restoreSandbox.isError,
                onRestore: () => recoverSandbox(restoreSandbox),
              },
            }
          : {}),
        // A turn paused for an approval, or cut short by a limit, also succeeds: it has no answer.
        answered:
          latestRun?.status === "succeeded" &&
          latestRun.finishReason === "stop" &&
          (latestRun.diagnostics ?? []).some(
            (diagnostic) => diagnostic.code === "workspace_not_saved"
          ),
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
    /** Saved user message ids the reader may edit in place. */
    editableMessageIds,
    /** The message currently open in the inline editor, or null. */
    editingMessage,
    startEditMessage,
    cancelEditMessage,
    /** Edit an earlier user message in place and restart the thread from there. */
    editMessage,
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
    /**
     * Spread into `<QuestionComposer>` while set, in the composer's place: the Agent's question,
     * until the reader answers it or sets it aside.
     */
    questionProps,
    /** Spread into `<PendingMessages>`, above the composer: what waits beside the running turn. */
    pendingProps,
    /** Spread into `<SandboxRecovery>` while set: the composer stays disabled until it is resolved. */
    sandboxRecoveryProps,
    /** Where the reader's own conversation runs, and how to switch it between cloud and computer. */
    place,
    /** Where the reader's own conversation runs on their computer, for its badge. */
    computer: access === "owner" ? (thread?.computer ?? null) : null,
    /** Spread into `<ComputerOfflineNotice>` while its computer is offline. */
    computerNoticeProps,
  }
}

/** Why a turn did not start or stop, or the mode did not change. */
type TurnFailure = AgentConversationSendError["code"]

/** The picker's name for the model a conversation's context is measured against. */
function meteredModelName(
  models: readonly LanguageModel[],
  ref: { readonly provider: string; readonly modelId: string } | undefined
): string | undefined {
  if (!ref) return undefined
  return models.find((model) => model.provider === ref.provider && model.modelId === ref.modelId)
    ?.name
}

/** Why a decision did not go through. Once the call ran, the decision stands and never throws. */
function decisionFailure(error: unknown): AgentApprovalDecisionFailure {
  if (!isSixbApiError(error)) return "failed"
  if (error.code === "approval_expired") return "expired"
  if (error.code === "approval_not_pending") return "decided"

  return "failed"
}

/** A message that did not go out: another answer holds the thread, the sandbox is away, or else. */
function sendFailure(error: unknown): TurnFailure {
  if (error instanceof ComputerUnavailableError) return "computer"
  if (!isSixbApiError(error) || error.status !== 409) return "send"
  if (error.code === "active_run_exists") return "busy"
  if (error.code === "sandbox_execution_unavailable") return "sandbox"

  return "send"
}

function editFailure(error: unknown): TurnFailure {
  if (error instanceof ComputerUnavailableError) return "computer"
  if (!isSixbApiError(error)) return "edit"
  // Someone else's answer runs, which only they or the thread's owner may stop.
  if (error.status === 403 && error.code === "not_run_requester") return "busy"
  if (error.status !== 409) return "edit"
  if (error.code === "active_run_exists") return "busy"
  if (error.code === "sandbox_execution_unavailable") return "sandbox"

  return "edit"
}

/** Why an edit did not go through, in words about the edit, said under the editor. */
function editFailureMessage(
  failure: TurnFailure,
  someoneElse: boolean,
  labels: ReturnType<typeof useAgentMessages>["chat"]
): string {
  switch (failure) {
    case "busy":
      return someoneElse ? labels.editBusyOther : labels.editBusy
    case "sandbox":
      return labels.sandboxUnavailable
    case "computer":
      return labels.computerUnavailable
    default:
      return labels.editFailed
  }
}

/** The edit a waiting inbox item holds, as the transcript shows one just saved. */
function waitingEditPending(threadId: string, item: AgentInboxItem): PendingUserMessage {
  return {
    key: `edit:${item.id}`,
    threadId,
    text: item.parts.map((part) => (part.type === "text" ? part.text : "")).join(""),
    attachments: item.parts.flatMap((part) => (part.type === "file" ? [part.fileRef] : [])),
    context: item.parts.flatMap((part) =>
      part.type === "context"
        ? [{ context: part.context as AgentContextInput, origin: part.origin }]
        : []
    ),
    messageId: item.messageId,
    ...(item.replacesMessageId === undefined ? {} : { replacesMessageId: item.replacesMessageId }),
  }
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
    case "computer":
      return labels.computerUnavailable
    case "edit":
      return labels.editFailed
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

function sameTurn(a: AgentConversationTurn, b: AgentConversationTurn): boolean {
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) {
    if (!Object.is(Reflect.get(a, key), Reflect.get(b, key))) return false
  }
  return true
}
