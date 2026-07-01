import { Bubble, BubbleContent, Marker, MarkerContent, MarkerIcon } from "@sixb/ui/components"
import { AlertTriangle } from "lucide-react"
import { isAwaitingFirstToken, type LiveRunState } from "../liveRun"
import { normalizeDurableParts } from "../parts"
import type { AgentMessage } from "../types"
import { AssistantBody } from "./MessageParts"

/** Render a single durable message. System messages are not shown in the reading transcript. */
export function MessageView({ message }: { message: AgentMessage }) {
  if (message.role === "user") return <UserMessage message={message} />
  if (message.role === "assistant") return <AssistantMessage message={message} />
  return null
}

function UserMessage({ message }: { message: AgentMessage }) {
  const text = textOf(message)
  if (!text) return null
  return (
    <div className="flex flex-col items-end">
      <Bubble variant="secondary" align="end">
        <BubbleContent className="whitespace-pre-wrap">{text}</BubbleContent>
      </Bubble>
    </div>
  )
}

function AssistantMessage({ message }: { message: AgentMessage }) {
  return <AssistantBody parts={normalizeDurableParts(message.parts)} />
}

/** The transient assistant row driven by the live `/ws/agents` stream. */
export function LiveAssistant({ live }: { live: LiveRunState }) {
  if (isAwaitingFirstToken(live)) {
    return <ThinkingMarker />
  }

  return (
    <div className="flex flex-col gap-2">
      <AssistantBody parts={live.parts} />
      {live.finishStatus === "failed" ? (
        <RunErrorMarker message={live.finishError ?? "The agent run failed."} />
      ) : null}
    </div>
  )
}

export function ThinkingMarker() {
  return (
    <Marker role="status" aria-label="Agent is thinking">
      <MarkerContent className="shimmer">Thinking…</MarkerContent>
    </Marker>
  )
}

/** Shown while an active run's stream has dropped and the client is re-subscribing. */
export function ReconnectingMarker() {
  return (
    <Marker role="status" aria-label="Reconnecting to the agent stream">
      <MarkerContent className="shimmer">Connection lost — reconnecting…</MarkerContent>
    </Marker>
  )
}

export function RunErrorMarker({ message }: { message: string }) {
  return (
    <Marker className="text-destructive">
      <MarkerIcon>
        <AlertTriangle className="text-destructive" />
      </MarkerIcon>
      <MarkerContent>{message}</MarkerContent>
    </Marker>
  )
}

function textOf(message: AgentMessage): string {
  return message.parts
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim()
}
