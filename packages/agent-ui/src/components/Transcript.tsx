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

  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller className="flex-1">
        <MessageScrollerViewport>
          <MessageScrollerContent
            aria-busy={live.active || showThinking}
            className="mx-auto w-full max-w-3xl px-4 py-6"
          >
            {messages.map((message) => (
              <MessageScrollerItem key={message.id} messageId={message.id} scrollAnchor>
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
              <MessageScrollerItem messageId="live" scrollAnchor>
                <LiveAssistant live={live} />
              </MessageScrollerItem>
            ) : showThinking ? (
              <MessageScrollerItem messageId="thinking" scrollAnchor>
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
