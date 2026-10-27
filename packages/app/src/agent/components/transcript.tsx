import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@sixb/ui/components"
import { Fragment, memo, type ReactNode, useMemo } from "react"
import {
  ApprovalCardsContext,
  type HeldCall,
  heldCallIdsInMessages,
  heldCallOf,
  type ReportedApprovalOutcome,
  type TranscriptApprovals,
} from "../approvals"
import type { AgentConversationMessage, AgentConversationTurn } from "../conversation"
import { DelegationCardsContext, type TranscriptDelegation } from "../delegation/context"
import {
  delegationTurns,
  readThreadDelegation,
  type ThreadDelegation,
} from "../delegation/interpret"
import { heldInCard } from "../delegation/model"
import { useAgentMessages } from "../i18n"
import { principalKey } from "../message-authors"
import { ApprovalCards } from "./approval-card"
import {
  CompactionMarker,
  MessageView,
  ReconnectingMarker,
  RunCancelledMarker,
  RunErrorMarker,
  RunFailureMarker,
  RunInterruptedMarker,
  RunTimeoutMarker,
  ThinkingMarker,
} from "./message-view"

export interface TranscriptProps {
  readonly threadId: string | null
  /** The conversation, as `useAgentConversation` merges it. */
  readonly messages: readonly AgentConversationMessage[]
  /** The newest turn, which the markers below the messages tell. */
  readonly turn: AgentConversationTurn
  /** This client started the current turn, so keep the user prompt anchored while it streams. */
  readonly anchorCurrentTurn?: boolean
  readonly onRetry?: () => void
  readonly onContinue?: () => void
  /**
   * The thread's calls held for approval. Each shows as a card under the work that made it, which
   * its requester answers; without them, as for an observer, the cards show only what the messages
   * report of how each ended.
   */
  readonly approvals?: TranscriptApprovals
  /** How each held call ended, as the messages that resumed or followed its turn told the agent. */
  readonly approvalOutcomes?: ReadonlyMap<string, ReportedApprovalOutcome>
  /**
   * What the reader may do with the sub-agents the agent delegated to, each a card under the work
   * that spawned it. Without it, as for an observer, the cards only read.
   */
  readonly delegation?: TranscriptDelegation
}

const NO_OUTCOMES: ReadonlyMap<string, ReportedApprovalOutcome> = new Map()

export function Transcript(props: TranscriptProps) {
  const { approvals, approvalOutcomes, messages, turn, threadId, delegation: actions } = props
  const cards = useMemo(
    () => ({ approvals: approvals ?? null, outcomes: approvalOutcomes ?? NO_OUTCOMES }),
    [approvals, approvalOutcomes]
  )

  // The reply streaming now changes with every chunk; its delegation calls far less often.
  const turns = delegationTurns(messages)
  const signature = JSON.stringify(
    turns.map((entry) => [entry.runId, entry.tools.map((tool) => [tool.toolName, tool.state])])
  )
  // biome-ignore lint/correctness/useExhaustiveDependencies: the signature stands for the turns
  const delegation = useMemo(() => readThreadDelegation(turns), [signature])
  const liveRunId = turn.kind === "responding" ? turn.runId : null
  const children = useMemo(
    () => ({ threadId, delegation, liveRunId, actions }),
    [threadId, delegation, liveRunId, actions]
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
  turn,
  anchorCurrentTurn,
  onRetry,
  onContinue,
  approvals,
}: TranscriptProps & { readonly threadDelegation: ThreadDelegation }) {
  // Messages one person sends in a row name them once; an answer in between names them again.
  const continuedKeys = useMemo(() => continuedUserMessages(messages), [messages])

  // The reply still streaming, or one whose run ended before it was saved: always the last one.
  const last = messages.at(-1)
  const liveReply = last?.role === "assistant" && last.id === null ? last : undefined

  // Bridge the gap between sending and the reply's first content with a thinking shimmer.
  const showThinking =
    turn.kind === "responding" &&
    !liveReply &&
    !messages.some((message) => message.role === "assistant" && message.runId === turn.runId)

  // A saved thread should open at the newest content, not at the first or last user turn. Only mark
  // a row as a scroll anchor while the current UI-initiated turn is in flight: the pending row
  // anchors, and keeps its place once its saved copy replaces it.
  const pending = messages.some((message) => message.status === "pending")
  const shouldAnchorCurrentTurn = Boolean(
    anchorCurrentTurn && (pending || liveReply || turn.kind !== "idle")
  )
  const anchoredKey = shouldAnchorCurrentTurn
    ? currentTurnAnchor(messages, turn.kind === "responding" ? turn.runId : liveReply?.runId)
    : lastKey(messages, (message) => message.status === "pending")
  const newestSavedKey = lastKey(messages, (message) => message.id !== null)

  // A call is answered on the card under the work that made it. One whose command output does not
  // name it, such as output sent elsewhere, still gets a card, after its turn's saved answer, and
  // keeps it once decided. One whose turn has no saved answer yet goes after the saved messages.
  const unshown = useMemo(() => {
    const byRun = new Map<string, HeldCall[]>()
    const all = approvals?.approvals ?? []
    if (all.length === 0) return { byRun, trailing: [] as HeldCall[] }

    const shown = heldCallIdsInMessages(messages)
    const answered = new Set(
      messages.flatMap((message) => (message.id !== null && message.runId ? [message.runId] : []))
    )
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
  }, [approvals, messages, threadDelegation])
  // The last saved message of each turn, where its unshown calls go.
  const lastOfRun = useMemo(() => {
    const last = new Map<string, string>()
    for (const message of messages) {
      if (message.id !== null && message.runId) last.set(message.runId, message.key)
    }
    return last
  }, [messages])
  // The messages not saved yet, the one just sent and the reply streaming, always come last.
  const firstUnsaved = messages.findIndex((message) => message.id === null)
  const trailingAt = firstUnsaved === -1 ? messages.length : firstUnsaved
  const trailingCards =
    unshown.trailing.length > 0 ? (
      <MessageScrollerItem messageId="approvals">
        <ApprovalCards calls={unshown.trailing} />
      </MessageScrollerItem>
    ) : null

  return (
    // Let the message-scroller own the complete chat contract: open saved threads at the latest
    // content, anchor a newly submitted prompt while the response fills the viewport, follow the
    // live edge once appropriate, and release immediately on human scroll intent. The jump button
    // explicitly resumes following after that override.
    <MessageScrollerProvider key={threadId ?? "draft"} autoScroll defaultScrollPosition="end">
      <MessageScroller className="flex-1">
        <MessageScrollerViewport>
          <MessageScrollerContent
            aria-busy={turn.kind === "responding"}
            className="mx-auto w-full max-w-3xl px-4 pt-12 pb-6"
          >
            {messages.map((message, index) => {
              const calls =
                message.runId && lastOfRun.get(message.runId) === message.key
                  ? unshown.byRun.get(message.runId)
                  : undefined
              return (
                <Fragment key={message.key}>
                  {index === trailingAt ? trailingCards : null}
                  <TranscriptMessage
                    message={message}
                    continued={continuedKeys.has(message.key)}
                    scrollAnchor={message.key === anchoredKey}
                    // Only the newest answer can be continued; older ones keep their notice alone.
                    {...(message.key === newestSavedKey && onContinue
                      ? { onContinue, continuing: turn.continuing }
                      : {})}
                    {...(message === liveReply
                      ? {
                          after: (
                            <TurnEnd
                              turn={turn}
                              message={message}
                              onRetry={onRetry}
                              onContinue={onContinue}
                            />
                          ),
                        }
                      : {})}
                  />
                  {calls ? (
                    <MessageScrollerItem messageId={`approvals:${message.key}`}>
                      <ApprovalCards calls={calls} />
                    </MessageScrollerItem>
                  ) : null}
                </Fragment>
              )
            })}
            {trailingAt === messages.length ? trailingCards : null}
            {liveReply ? null : showThinking && turn.kind === "responding" ? (
              <MessageScrollerItem messageId="thinking" scrollAnchor={anchoredKey === THINKING}>
                {turn.compacting ? (
                  <CompactionMarker />
                ) : (
                  <ThinkingMarker takingLonger={turn.waitingLonger} />
                )}
              </MessageScrollerItem>
            ) : turn.kind === "timeout" ? (
              <MessageScrollerItem messageId="run-timeout">
                <RunTimeoutMarker
                  hasProgress={turn.hasProgress}
                  timeoutMs={turn.timeoutMs}
                  onRetry={onRetry}
                  onContinue={onContinue}
                  retrying={turn.retrying}
                  continuing={turn.continuing}
                />
              </MessageScrollerItem>
            ) : turn.kind === "interrupted" ? (
              <MessageScrollerItem messageId="run-interrupted">
                <RunInterruptedMarker
                  hasProgress={turn.hasProgress}
                  onRetry={onRetry}
                  onContinue={onContinue}
                  retrying={turn.retrying}
                  continuing={turn.continuing}
                />
              </MessageScrollerItem>
            ) : turn.kind === "failed" ? (
              <MessageScrollerItem messageId="run-failed">
                <RunFailureMarker onRetry={onRetry} retrying={turn.retrying} />
              </MessageScrollerItem>
            ) : turn.kind === "cancelled" ? (
              <MessageScrollerItem messageId="run-cancelled">
                <RunCancelledMarker />
              </MessageScrollerItem>
            ) : null}
            {turn.kind === "responding" && turn.reconnecting ? (
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

/** How the turn of a reply that was never saved ended, below what it streamed. */
function TurnEnd({
  turn,
  message,
  onRetry,
  onContinue,
}: {
  readonly turn: AgentConversationTurn
  readonly message: AgentConversationMessage
  readonly onRetry?: () => void
  readonly onContinue?: () => void
}) {
  const labels = useAgentMessages().transcript

  if (turn.kind === "timeout") {
    return (
      <RunTimeoutMarker
        hasProgress={turn.hasProgress}
        timeoutMs={turn.timeoutMs}
        onRetry={onRetry}
        onContinue={onContinue}
        retrying={turn.retrying}
        continuing={turn.continuing}
      />
    )
  }
  if (turn.kind === "interrupted") {
    return (
      <RunInterruptedMarker
        hasProgress={turn.hasProgress}
        onRetry={onRetry}
        onContinue={onContinue}
        retrying={turn.retrying}
        continuing={turn.continuing}
      />
    )
  }
  if (message.unfinished === "failed") return <RunErrorMarker message={labels.notFinished} />
  if (message.unfinished === "cancelled") return <RunCancelledMarker />

  return null
}

// A live chunk should only reconcile the transient assistant row. Completed rows can contain
// substantial Markdown, tables, and file previews, so keep their scroller wrappers stable too.
const TranscriptMessage = memo(function TranscriptMessage({
  message,
  continued,
  scrollAnchor,
  onContinue,
  continuing,
  after,
}: {
  readonly message: AgentConversationMessage
  readonly continued: boolean
  readonly scrollAnchor: boolean
  readonly onContinue?: () => void
  readonly continuing?: boolean
  readonly after?: ReactNode
}) {
  return (
    <MessageScrollerItem messageId={message.key} scrollAnchor={scrollAnchor}>
      <MessageView
        message={message}
        continued={continued}
        onContinue={onContinue}
        continuing={continuing}
        after={after}
      />
    </MessageScrollerItem>
  )
})

/**
 * The user messages that directly follow another from the same author. An answer between two
 * messages starts a new run.
 */
function continuedUserMessages(messages: readonly AgentConversationMessage[]): Set<string> {
  const continued = new Set<string>()
  let lastUserAuthor: string | null = null

  for (const message of messages) {
    if (message.role === "assistant") {
      lastUserAuthor = null
      continue
    }

    const key = message.author ? principalKey(message.author) : null
    if (key !== null && key === lastUserAuthor) continued.add(message.key)
    lastUserAuthor = key
  }

  return continued
}

const THINKING = "thinking"

/**
 * The row the current turn anchors: the question it answers. A turn Continue started answers none
 * of the reader's messages, as an answer of an earlier turn follows the last one: it anchors its
 * own reply instead, or the thinking row until that reply streams.
 */
function currentTurnAnchor(
  messages: readonly AgentConversationMessage[],
  turnRunId: string | null | undefined
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!message) continue
    if (message.role === "user") return message.key

    const earlierAnswer = message.id !== null && message.runId !== (turnRunId ?? null)
    if (earlierAnswer) {
      const reply = messages.at(-1)
      return reply?.role === "assistant" && reply.runId === turnRunId ? reply.key : THINKING
    }
  }

  return undefined
}

function lastKey(
  messages: readonly AgentConversationMessage[],
  matches: (message: AgentConversationMessage) => boolean
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message && matches(message)) return message.key
  }
  return undefined
}
