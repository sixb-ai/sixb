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
import { useMemo } from "react"
import { hasLiveContent, type LiveRunState } from "../liveRun"
import type { AgentMessage } from "../types"
import { LiveAssistant, MessageView, ThinkingMarker } from "./MessageView"

export interface TranscriptProps {
  readonly messages: readonly AgentMessage[]
  readonly live: LiveRunState
  /** A just-sent user message echoed locally until durable state catches up. */
  readonly pendingUserText?: string | null
  /** A run is requested but the live stream hasn't produced content yet — show a thinking shimmer. */
  readonly awaitingResponse?: boolean
}

export function Transcript({ messages, live, pendingUserText, awaitingResponse }: TranscriptProps) {
  // Keep the live row until the finalized assistant message is present in durable state, so the
  // handoff from streaming to stored content never flashes empty.
  const finalizedInDurable =
    live.finalizedMessageId !== null &&
    messages.some((message) => message.id === live.finalizedMessageId)
  const showLive = hasLiveContent(live, live.runId) && !finalizedInDurable
  // Bridge the gap between sending and the first stream event with a standalone thinking shimmer.
  const showThinking = Boolean(awaitingResponse) && !showLive && !finalizedInDurable

  // Only the *current* turn's user message is a scroll anchor — the row the scroller lifts to the top
  // of the viewport so the answer can stream into the space below it. Anchoring every historical user
  // message instead makes the scroller jump to the first one when the optimistic echo is swapped for
  // the durable message (the primitive re-targets the first not-yet-handled anchor on equal-count
  // updates). While the optimistic echo is showing, it is the live turn, so no durable row anchors.
  const lastUserMessageId = useMemo(() => {
    if (pendingUserText) return null
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") return messages[i].id
    }
    return null
  }, [messages, pendingUserText])

  return (
    // A turn begins at its user message: anchoring it lifts the new turn to the top of the viewport
    // and lets the answer stream into the space below, with the prior turn peeking above for context.
    // `last-anchor` reopens a saved thread at the last user turn rather than the absolute bottom.
    //
    // No `autoScroll`: anchoring inflates a spacer so the turn can reach the top, which leaves the
    // viewport sitting at its own scroll-bottom. With `autoScroll` the scroller reads that as "follow
    // the live edge", collapses the spacer on the next token, and pins everything to the bottom —
    // exactly the behavior we're avoiding. Without it the turn stays anchored at the top while the
    // answer streams in below, and `MessageScrollerButton` remains for an explicit jump to latest.
    <MessageScrollerProvider defaultScrollPosition="last-anchor">
      <MessageScroller className="flex-1">
        <MessageScrollerViewport>
          <MessageScrollerContent
            aria-busy={live.active || showThinking}
            className="mx-auto w-full max-w-3xl px-4 py-6"
          >
            {messages.map((message) => (
              <MessageScrollerItem
                key={message.id}
                messageId={message.id}
                scrollAnchor={message.id === lastUserMessageId}
              >
                <MessageView message={message} />
              </MessageScrollerItem>
            ))}
            {pendingUserText ? (
              <MessageScrollerItem messageId="pending-user" scrollAnchor>
                <div className="flex flex-col items-end">
                  <Bubble variant="secondary" align="end">
                    <BubbleContent className="whitespace-pre-wrap">{pendingUserText}</BubbleContent>
                  </Bubble>
                </div>
              </MessageScrollerItem>
            ) : null}
            {showLive ? (
              // The answer is not a turn anchor — it grows into the space below the anchored user
              // message, so streaming never yanks the reader away from where the turn started.
              <MessageScrollerItem messageId="live">
                <LiveAssistant live={live} />
              </MessageScrollerItem>
            ) : showThinking ? (
              <MessageScrollerItem messageId="thinking">
                <ThinkingMarker />
              </MessageScrollerItem>
            ) : null}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  )
}
