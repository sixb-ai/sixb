import {
  Bubble,
  BubbleContent,
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from "@sixb/ui/components"
import { useLayoutEffect, useMemo, useRef } from "react"
import { hasLiveContent, type LiveRunState } from "../liveRun"
import type { AgentFileRef, AgentMessage } from "../types"
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
        showLive ||
        showThinking ||
        handoffPending ||
        live.finishStatus !== null)
  )
  const anchoredUserMessageId = useMemo(() => {
    if (pendingUserText || pendingUserAttachments.length > 0 || !shouldAnchorCurrentTurn)
      return null
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") return messages[i].id
    }
    return null
  }, [messages, pendingUserText, pendingUserAttachments.length, shouldAnchorCurrentTurn])

  return (
    // Opening an existing thread should land at the bottom/latest message. New in-flight turns still
    // get an explicit anchor (pending user, then durable user) so the answer can stream into stable
    // space below the prompt without changing the initial load behavior for saved threads.
    //
    // No `autoScroll`: anchoring inflates a spacer so the turn can reach the top, which leaves the
    // viewport sitting at its own scroll-bottom. With `autoScroll` the scroller reads that as "follow
    // the live edge", collapses the spacer on the next token, and pins everything to the bottom —
    // exactly the behavior we're avoiding. Without it the turn stays anchored at the top while the
    // answer streams in below, and `MessageScrollerButton` remains for an explicit jump to latest.
    <MessageScrollerProvider key={threadId ?? "draft"} defaultScrollPosition="end">
      <MessageScroller className="flex-1">
        <ScrollToLatestOnThreadLoad
          threadId={threadId}
          enabled={!shouldAnchorCurrentTurn}
          hasMessages={
            messages.length > 0 ||
            Boolean(pendingUserText) ||
            pendingUserAttachments.length > 0 ||
            showLive ||
            showThinking
          }
          currentTurnActive={Boolean(anchorCurrentTurn)}
        />
        <MessageScrollerViewport>
          <MessageScrollerContent
            aria-busy={live.active || showThinking}
            className="mx-auto w-full max-w-3xl px-4 py-6"
          >
            {messages.map((message) => (
              <MessageScrollerItem
                key={message.id}
                messageId={message.id}
                scrollAnchor={message.id === anchoredUserMessageId}
              >
                <MessageView message={message} />
              </MessageScrollerItem>
            ))}
            {pendingUserText || pendingUserAttachments.length > 0 ? (
              <MessageScrollerItem messageId="pending-user" scrollAnchor>
                <div className="flex flex-col items-end gap-1.5">
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

function ScrollToLatestOnThreadLoad({
  threadId,
  enabled,
  hasMessages,
  currentTurnActive,
}: {
  threadId: string | null
  enabled: boolean
  hasMessages: boolean
  currentTurnActive: boolean
}) {
  const { scrollToEnd } = useMessageScroller()
  const didInitialScrollRef = useRef(false)
  const suppressInitialScrollRef = useRef(false)

  // Reset only when a different thread opens. If the current thread starts an in-flight turn, we
  // suppress this initial-load scroll for the rest of that thread view; otherwise the completion
  // handoff would flip `enabled` back on and yank the transcript to the bottom.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally reset only per thread
  useLayoutEffect(() => {
    didInitialScrollRef.current = false
    suppressInitialScrollRef.current = currentTurnActive
  }, [threadId])

  useLayoutEffect(() => {
    if (currentTurnActive) suppressInitialScrollRef.current = true
  }, [currentTurnActive])

  useLayoutEffect(() => {
    if (
      !threadId ||
      !enabled ||
      !hasMessages ||
      currentTurnActive ||
      didInitialScrollRef.current ||
      suppressInitialScrollRef.current
    ) {
      return
    }

    didInitialScrollRef.current = true
    let frameOne = 0
    let frameTwo = 0
    const timers: number[] = []
    const scroll = () => scrollToEnd({ behavior: "auto" })

    scroll()
    frameOne = window.requestAnimationFrame(() => {
      scroll()
      frameTwo = window.requestAnimationFrame(scroll)
    })
    timers.push(window.setTimeout(scroll, 80), window.setTimeout(scroll, 240))

    return () => {
      window.cancelAnimationFrame(frameOne)
      window.cancelAnimationFrame(frameTwo)
      timers.forEach((timer) => {
        window.clearTimeout(timer)
      })
    }
  }, [currentTurnActive, enabled, hasMessages, scrollToEnd, threadId])

  return null
}
