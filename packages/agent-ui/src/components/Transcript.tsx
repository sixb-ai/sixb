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
import { memo, useMemo } from "react"
import { hasLiveContent, type LiveRunState } from "../liveRun"
import type { AgentContextEntryInput, AgentFileRef, AgentMessage } from "../types"
import { ContextChips } from "./ContextChips"
import {
  LiveAssistant,
  MessageView,
  ReconnectingMarker,
  RunCancelledMarker,
  RunFailureMarker,
  ThinkingMarker,
  UserFileAttachment,
} from "./MessageView"

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
  readonly onRetry?: () => void
  readonly retrying?: boolean
  /** The active run's stream dropped and is re-subscribing — surface a transient notice. */
  readonly reconnecting?: boolean
}

export function Transcript({
  threadId,
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
  onRetry,
  retrying,
  reconnecting,
}: TranscriptProps) {
  // Keep the live row until the finalized assistant message is present in durable state, so the
  // handoff from streaming to stored content never flashes empty.
  const finalizedInDurable =
    live.finalizedMessageId !== null &&
    messages.some((message) => message.id === live.finalizedMessageId)
  const showLive = hasLiveContent(live, live.runId) && !finalizedInDurable
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
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") return messages[i].id
    }
    return null
  }, [
    messages,
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
            className="mx-auto w-full max-w-3xl px-4 py-6"
          >
            {messages.map((message) => (
              <TranscriptMessage
                key={message.id}
                message={message}
                scrollAnchor={message.id === anchoredUserMessageId}
              />
            ))}
            {pendingUserText ||
            pendingUserAttachments.length > 0 ||
            pendingUserContext.length > 0 ? (
              <MessageScrollerItem messageId="pending-user" scrollAnchor>
                <div className="flex flex-col items-end gap-1.5">
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
                  onRetry={onRetry}
                  retrying={retrying}
                />
              </MessageScrollerItem>
            ) : showThinking ? (
              <MessageScrollerItem messageId="thinking">
                <ThinkingMarker takingLonger={waitingLonger} />
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
  scrollAnchor,
}: {
  readonly message: AgentMessage
  readonly scrollAnchor: boolean
}) {
  return (
    <MessageScrollerItem messageId={message.id} scrollAnchor={scrollAnchor}>
      <MessageView message={message} />
    </MessageScrollerItem>
  )
})
