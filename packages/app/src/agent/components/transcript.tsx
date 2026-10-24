import {
  Bubble,
  BubbleContent,
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@sixb/ui/components"
import { Fragment, memo, useMemo } from "react"
import {
  ApprovalCardsContext,
  type HeldCall,
  heldCallIdsInMessages,
  heldCallOf,
  heldCallsInParts,
  isApprovalOutcomeMessage,
  reportedApprovalOutcomes,
  type TranscriptApprovals,
} from "../approvals"
import { DelegationCardsContext, type TranscriptDelegation } from "../delegation/context"
import {
  delegationTools,
  delegationTurns,
  readThreadDelegation,
  type ThreadDelegation,
} from "../delegation/interpret"
import { heldInCard } from "../delegation/model"
import { hasLiveContent, type LiveRunState } from "../live-run"
import { authorKey, useMessageAuthors } from "../message-authors"
import type { AgentContextEntryInput, AgentFileRef, AgentMessage } from "../types"
import { ApprovalCards } from "./approval-card"
import { ContextChips } from "./context-chips"
import {
  AuthorLine,
  LiveAssistant,
  MessageView,
  ReconnectingMarker,
  RunCancelledMarker,
  RunFailureMarker,
  RunInterruptedMarker,
  RunTimeoutMarker,
  ThinkingMarker,
  UserFileAttachment,
} from "./message-view"

export interface TranscriptProps {
  readonly threadId: string | null
  readonly messages: readonly AgentMessage[]
  readonly live: LiveRunState
  /** A just-sent user message echoed locally until durable state catches up. */
  readonly pendingUserText?: string | null
  readonly pendingUserAttachments?: readonly AgentFileRef[]
  readonly pendingUserContext?: readonly AgentContextEntryInput[]
  /** This client initiated the current turn, so keep the user prompt anchored while it streams. */
  readonly anchorCurrentTurn?: boolean
  /** A run is requested but the live stream hasn't produced content yet — show a thinking shimmer. */
  readonly awaitingResponse?: boolean
  /** The queued run has crossed the conversational delay threshold. */
  readonly waitingLonger?: boolean
  /** The newest run failed before it produced a durable assistant message. */
  readonly failedBeforeResponse?: boolean
  readonly cancelledBeforeResponse?: boolean
  readonly timeout?: { readonly hasProgress: boolean; readonly timeoutMs?: number }
  /** The newest run lost its worker mid-turn; without saved progress, its stream is not shown. */
  readonly interrupted?: { readonly hasProgress: boolean }
  readonly onRetry?: () => void
  readonly onContinue?: () => void
  readonly retrying?: boolean
  readonly continuing?: boolean
  /** The active run's stream dropped and is re-subscribing — surface a transient notice. */
  readonly reconnecting?: boolean
  /**
   * The thread's calls held for approval. Each shows as a card under the work that made it, which
   * its requester answers; without them, as for an observer, the cards show only what the messages
   * report of how each ended.
   */
  readonly approvals?: TranscriptApprovals
  /**
   * What the reader may do with the sub-agents the agent delegated to, each a card under the work
   * that spawned it. Without it, as for an observer, the cards only read.
   */
  readonly delegation?: TranscriptDelegation
}

export function Transcript(props: TranscriptProps) {
  const { approvals, messages, live, threadId, delegation: actions } = props
  const cards = useMemo(
    () => ({ approvals: approvals ?? null, outcomes: reportedApprovalOutcomes(messages) }),
    [approvals, messages]
  )

  // The turn streaming now changes with every chunk; its delegation calls far less often.
  const turns = useMemo(() => delegationTurns(messages), [messages])
  // Once its answer is stored, the turn that streamed is read from it, never twice.
  const stored = live.runId !== null && messages.some((message) => message.runId === live.runId)
  const liveTools = stored ? [] : delegationTools(live.parts)
  const liveSignature = JSON.stringify(liveTools.map((tool) => [tool.toolName, tool.state]))
  // biome-ignore lint/correctness/useExhaustiveDependencies: the signature stands for the tools
  const delegation = useMemo(
    () => readThreadDelegation([...turns, { runId: live.runId, tools: liveTools }]),
    [turns, live.runId, liveSignature]
  )
  const children = useMemo(
    () => ({ threadId, delegation, liveRunId: live.active ? live.runId : null, actions }),
    [threadId, delegation, live.active, live.runId, actions]
  )

  return (
    <ApprovalCardsContext.Provider value={cards}>
      <DelegationCardsContext.Provider value={children}>
        <TranscriptView {...props} threadDelegation={delegation} />
      </DelegationCardsContext.Provider>
    </ApprovalCardsContext.Provider>
  )
}

function TranscriptView({
  threadId,
  threadDelegation,
  messages,
  live,
  pendingUserText,
  pendingUserAttachments = [],
  pendingUserContext = [],
  anchorCurrentTurn,
  awaitingResponse,
  waitingLonger,
  failedBeforeResponse,
  cancelledBeforeResponse,
  timeout,
  interrupted,
  onRetry,
  onContinue,
  retrying,
  continuing,
  reconnecting,
  approvals,
}: TranscriptProps & { readonly threadDelegation: ThreadDelegation }) {
  const authors = useMessageAuthors()

  // The message Sixb writes to resume a turn says only how its calls ended, which their cards
  // show: leaving it out keeps the resumed answer right under the one it continues.
  const shownMessages = useMemo(
    () => messages.filter((message) => !isApprovalOutcomeMessage(message)),
    [messages]
  )

  // A call is answered on the card under the work that made it. One whose command output does not
  // name it, such as output sent elsewhere, still gets a card, after its turn's answer, and keeps it
  // once decided. One whose turn has no answer yet closes the transcript.
  const unshown = useMemo(() => {
    const byRun = new Map<string, HeldCall[]>()
    const all = approvals?.approvals ?? []
    if (all.length === 0) return { byRun, trailing: [] as HeldCall[] }

    const shown = new Set([
      ...heldCallIdsInMessages(messages),
      ...heldCallsInParts(live.parts).map((call) => call.id),
    ])
    const answered = new Set(messages.flatMap((message) => (message.runId ? [message.runId] : [])))
    const trailing: HeldCall[] = []
    for (const approval of all) {
      if (shown.has(approval.id)) continue
      // A sub-agent's call shows in its card when the turn that spawned it holds it.
      if (heldInCard(approval, threadDelegation)) continue
      if (!answered.has(approval.runId)) {
        trailing.push(heldCallOf(approval))
        continue
      }
      byRun.set(approval.runId, [...(byRun.get(approval.runId) ?? []), heldCallOf(approval)])
    }
    return { byRun, trailing }
  }, [approvals, messages, live.parts, threadDelegation])
  // The last message of each turn, where its unshown calls go.
  const lastOfRun = useMemo(() => {
    const last = new Map<string, string>()
    for (const message of shownMessages) if (message.runId) last.set(message.runId, message.id)
    return last
  }, [shownMessages])

  // Messages one person sends in a row name them once; an answer in between names them again.
  const { continuedIds, lastUserAuthor } = useMemo(
    () => userMessageRuns(shownMessages),
    [shownMessages]
  )
  const pendingContinues = authors?.reader !== undefined && lastUserAuthor === authors.reader.key

  // Keep the live row until the finalized assistant message is present in durable state, so the
  // handoff from streaming to stored content never flashes empty.
  const finalizedInDurable =
    live.finalizedMessageId !== null &&
    messages.some((message) => message.id === live.finalizedMessageId)
  const showLive =
    hasLiveContent(live, live.runId) &&
    !finalizedInDurable &&
    !(interrupted && !interrupted.hasProgress)
  const handoffPending = live.finalizedMessageId !== null && !finalizedInDurable
  // Bridge the gap between sending and the first stream event with a standalone thinking shimmer.
  const showThinking = Boolean(awaitingResponse) && !showLive && !finalizedInDurable

  // A saved thread should open at the newest content, not at the first or last user turn. Only mark
  // a user row as a scroll anchor while the current UI-initiated turn is in flight: the optimistic
  // row anchors first, then the durable user row takes over once it replaces the optimistic echo.
  const shouldAnchorCurrentTurn = Boolean(
    anchorCurrentTurn &&
      (pendingUserText ||
        pendingUserAttachments.length > 0 ||
        pendingUserContext.length > 0 ||
        showLive ||
        showThinking ||
        handoffPending ||
        live.finishStatus !== null)
  )
  const anchoredUserMessageId = useMemo(() => {
    if (
      pendingUserText ||
      pendingUserAttachments.length > 0 ||
      pendingUserContext.length > 0 ||
      !shouldAnchorCurrentTurn
    )
      return null
    for (let i = shownMessages.length - 1; i >= 0; i--) {
      if (shownMessages[i].role === "user") return shownMessages[i].id
    }
    return null
  }, [
    shownMessages,
    pendingUserText,
    pendingUserAttachments.length,
    pendingUserContext.length,
    shouldAnchorCurrentTurn,
  ])

  return (
    // Let the message-scroller own the complete chat contract: open saved threads at the latest
    // content, anchor a newly submitted prompt while the response fills the viewport, follow the
    // live edge once appropriate, and release immediately on human scroll intent. The jump button
    // explicitly resumes following after that override.
    <MessageScrollerProvider key={threadId ?? "draft"} autoScroll defaultScrollPosition="end">
      <MessageScroller className="flex-1">
        <MessageScrollerViewport>
          <MessageScrollerContent
            aria-busy={live.active || showThinking}
            className="mx-auto w-full max-w-3xl px-4 pt-12 pb-6"
          >
            {shownMessages.map((message, index) => {
              const calls =
                message.runId && lastOfRun.get(message.runId) === message.id
                  ? unshown.byRun.get(message.runId)
                  : undefined
              return (
                <Fragment key={message.id}>
                  <TranscriptMessage
                    message={message}
                    continued={continuedIds.has(message.id)}
                    scrollAnchor={message.id === anchoredUserMessageId}
                    // Only the newest answer can be continued; older ones keep their notice alone.
                    {...(index === shownMessages.length - 1 && onContinue
                      ? { onContinue, continuing: Boolean(continuing) }
                      : {})}
                  />
                  {calls ? (
                    <MessageScrollerItem messageId={`approvals:${message.id}`}>
                      <ApprovalCards calls={calls} />
                    </MessageScrollerItem>
                  ) : null}
                </Fragment>
              )
            })}
            {unshown.trailing.length > 0 ? (
              <MessageScrollerItem messageId="approvals">
                <ApprovalCards calls={unshown.trailing} />
              </MessageScrollerItem>
            ) : null}
            {pendingUserText ||
            pendingUserAttachments.length > 0 ||
            pendingUserContext.length > 0 ? (
              <MessageScrollerItem messageId="pending-user" scrollAnchor>
                <div className="flex flex-col items-end gap-1.5">
                  {pendingContinues ? null : <AuthorLine author={authors?.reader} />}
                  <ContextChips entries={pendingUserContext} className="justify-end" />
                  {pendingUserAttachments.length > 0 ? (
                    <div className="flex max-w-[min(80%,32rem)] flex-col items-end gap-1.5">
                      {pendingUserAttachments.map((fileRef, index) => (
                        <UserFileAttachment key={`${fileRef.blobId}-${index}`} fileRef={fileRef} />
                      ))}
                    </div>
                  ) : null}
                  {pendingUserText ? (
                    <Bubble variant="secondary" align="end">
                      <BubbleContent className="whitespace-pre-wrap">
                        {pendingUserText}
                      </BubbleContent>
                    </Bubble>
                  ) : null}
                </div>
              </MessageScrollerItem>
            ) : null}
            {showLive ? (
              // The answer is not a turn anchor — it grows into the space below the anchored user
              // message, so streaming never yanks the reader away from where the turn started.
              <MessageScrollerItem messageId="live">
                <LiveAssistant
                  live={live}
                  keepWorkOpen={handoffPending}
                  timeout={timeout}
                  interrupted={interrupted}
                  onRetry={onRetry}
                  onContinue={onContinue}
                  retrying={retrying}
                  continuing={continuing}
                />
              </MessageScrollerItem>
            ) : showThinking ? (
              <MessageScrollerItem messageId="thinking">
                <ThinkingMarker takingLonger={waitingLonger} />
              </MessageScrollerItem>
            ) : timeout ? (
              <MessageScrollerItem messageId="run-timeout">
                <RunTimeoutMarker
                  hasProgress={timeout.hasProgress}
                  timeoutMs={timeout.timeoutMs}
                  onRetry={onRetry}
                  onContinue={onContinue}
                  retrying={retrying}
                  continuing={continuing}
                />
              </MessageScrollerItem>
            ) : interrupted ? (
              <MessageScrollerItem messageId="run-interrupted">
                <RunInterruptedMarker
                  hasProgress={interrupted.hasProgress}
                  onRetry={onRetry}
                  onContinue={onContinue}
                  retrying={retrying}
                  continuing={continuing}
                />
              </MessageScrollerItem>
            ) : failedBeforeResponse ? (
              <MessageScrollerItem messageId="run-failed">
                <RunFailureMarker onRetry={onRetry} retrying={retrying} />
              </MessageScrollerItem>
            ) : cancelledBeforeResponse ? (
              <MessageScrollerItem messageId="run-cancelled">
                <RunCancelledMarker />
              </MessageScrollerItem>
            ) : null}
            {live.active && reconnecting ? (
              <MessageScrollerItem messageId="reconnecting">
                <ReconnectingMarker />
              </MessageScrollerItem>
            ) : null}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  )
}

// A live chunk should only reconcile the transient assistant row. Completed rows can contain
// substantial Markdown, tables, and file previews, so keep their scroller wrappers stable too.
const TranscriptMessage = memo(function TranscriptMessage({
  message,
  continued,
  scrollAnchor,
  onContinue,
  continuing,
}: {
  readonly message: AgentMessage
  readonly continued: boolean
  readonly scrollAnchor: boolean
  readonly onContinue?: () => void
  readonly continuing?: boolean
}) {
  return (
    <MessageScrollerItem messageId={message.id} scrollAnchor={scrollAnchor}>
      <MessageView
        message={message}
        continued={continued}
        onContinue={onContinue}
        continuing={continuing}
      />
    </MessageScrollerItem>
  )
})

/**
 * The user messages that directly follow another from the same author, and who wrote the last
 * message if it is a user's. An answer between two messages starts a new run.
 */
function userMessageRuns(messages: readonly AgentMessage[]) {
  const continuedIds = new Set<string>()
  let lastUserAuthor: string | null = null

  for (const message of messages) {
    if (message.role === "assistant") {
      lastUserAuthor = null
      continue
    }
    if (message.role !== "user") continue

    const key = authorKey(message)
    if (key !== null && key === lastUserAuthor) continuedIds.add(message.id)
    lastUserAuthor = key
  }

  return { continuedIds, lastUserAuthor }
}
