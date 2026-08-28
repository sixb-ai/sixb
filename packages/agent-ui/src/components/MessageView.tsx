import {
  Bubble,
  BubbleContent,
  Button,
  Marker,
  MarkerContent,
  MarkerIcon,
} from "@sixb/ui/components"
import { AlertTriangle, ArrowRight, Clock3, RotateCcw } from "lucide-react"
import { memo } from "react"
import { createAgentDocumentSource } from "../document-preview/source"
import type { AgentDocumentSource } from "../document-preview/types"
import { isAwaitingFirstToken, type LiveRunState } from "../liveRun"
import { normalizeDurableParts } from "../parts"
import type {
  AgentContextEntryInput,
  AgentContextInput,
  AgentFileRef,
  AgentMessage,
} from "../types"
import { ACTIVITY_STATUS_ROW_CLASS_NAME, ActivityStatusText } from "./ActivityStatus"
import { ContextChips } from "./ContextChips"
import { FileAttachmentCard } from "./FileAttachmentCard"
import { AssistantBody } from "./MessageParts"

/** Render a single durable message. System messages are not shown in the reading transcript. */
export const MessageView = memo(function MessageView({ message }: { message: AgentMessage }) {
  if (message.role === "user") return <UserMessage message={message} />
  if (message.role === "assistant") return <AssistantMessage message={message} />
  return null
})

function UserMessage({ message }: { message: AgentMessage }) {
  const text = textOf(message)
  const files = filePartsOf(message)
  const context = contextPartsOf(message)
  if (!text && files.length === 0 && context.length === 0) return null
  return (
    <div className="flex flex-col items-end gap-1.5">
      <ContextChips entries={context} className="max-w-[min(90%,40rem)] justify-end" />
      {files.length > 0 ? (
        <div className="flex max-w-[min(80%,32rem)] flex-col items-end gap-1.5">
          {files.map(({ part, index }) => (
            <UserFileAttachment
              key={index}
              fileRef={part.fileRef}
              document={agentMessageDocumentSource(message, index)}
            />
          ))}
        </div>
      ) : null}
      {text ? (
        <Bubble variant="secondary" align="end">
          <BubbleContent className="whitespace-pre-wrap">{text}</BubbleContent>
        </Bubble>
      ) : null}
    </div>
  )
}

function AssistantMessage({ message }: { message: AgentMessage }) {
  return (
    <div className="flex flex-col gap-2">
      <AssistantBody
        parts={normalizeDurableParts(message.parts, {
          fileSource: (partIndex) => agentMessageDocumentSource(message, partIndex),
        })}
      />
      {message.annotations.map((annotation, index) => (
        <Marker
          key={`${annotation.code}:${annotation.path ?? "run"}:${index}`}
          className={
            annotation.severity === "error"
              ? "text-destructive"
              : "text-amber-700 dark:text-amber-400"
          }
          role="status"
        >
          <MarkerIcon>
            <AlertTriangle
              className={
                annotation.severity === "error"
                  ? "text-destructive"
                  : "text-amber-600 dark:text-amber-400"
              }
            />
          </MarkerIcon>
          <MarkerContent>
            {annotation.path ? `${annotation.path}: ` : ""}
            {annotation.message}
          </MarkerContent>
        </Marker>
      ))}
    </div>
  )
}

/** The transient assistant row driven by the live `/ws/agents` stream. */
export function LiveAssistant({
  live,
  keepWorkOpen = false,
  timeout,
  onRetry,
  onContinue,
  retrying = false,
  continuing = false,
}: {
  live: LiveRunState
  keepWorkOpen?: boolean
  timeout?: { readonly hasProgress: boolean; readonly timeoutMs?: number }
  onRetry?: () => void
  onContinue?: () => void
  retrying?: boolean
  continuing?: boolean
}) {
  if (isAwaitingFirstToken(live)) {
    return <ThinkingMarker />
  }
  if (timeout) {
    if (live.parts.length === 0) {
      return (
        <RunTimeoutMarker
          hasProgress={timeout.hasProgress}
          timeoutMs={timeout.timeoutMs}
          onRetry={onRetry}
          onContinue={onContinue}
          retrying={retrying}
          continuing={continuing}
        />
      )
    }
    return (
      <div className="flex flex-col gap-2">
        <AssistantBody parts={live.parts} live={live.active || keepWorkOpen} />
        <RunTimeoutMarker
          hasProgress={timeout.hasProgress}
          timeoutMs={timeout.timeoutMs}
          onRetry={onRetry}
          onContinue={onContinue}
          retrying={retrying}
          continuing={continuing}
        />
      </div>
    )
  }
  if (live.finishStatus === "failed" && live.parts.length === 0) {
    return <RunFailureMarker onRetry={onRetry} retrying={retrying} />
  }
  if (live.finishStatus === "cancelled" && live.parts.length === 0) {
    return <RunCancelledMarker />
  }

  return (
    <div className="flex flex-col gap-2">
      <AssistantBody parts={live.parts} live={live.active || keepWorkOpen} />
      {live.finishStatus === "failed" ? (
        <RunErrorMarker message="I couldn’t finish that response." />
      ) : null}
      {live.finishStatus === "cancelled" ? <RunCancelledMarker /> : null}
    </div>
  )
}

export function ThinkingMarker({ takingLonger = false }: { takingLonger?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <div className={ACTIVITY_STATUS_ROW_CLASS_NAME} role="status" aria-label="Agent is working">
        <ActivityStatusText label="Thinking" className="shimmer" />
      </div>
      {takingLonger ? (
        <p className="px-1 text-xs text-muted-foreground" role="status">
          Taking a little longer than usual…
        </p>
      ) : null}
    </div>
  )
}

export function RunCancelledMarker() {
  return <p className="text-sm text-muted-foreground">Stopped.</p>
}

export function RunTimeoutMarker({
  hasProgress,
  timeoutMs,
  onRetry,
  onContinue,
  retrying = false,
  continuing = false,
}: {
  hasProgress: boolean
  timeoutMs?: number
  onRetry?: () => void
  onContinue?: () => void
  retrying?: boolean
  continuing?: boolean
}) {
  const limit = formatTurnTimeout(timeoutMs)
  return (
    <div className="flex flex-wrap items-center gap-2" role="status">
      <Marker className="text-amber-700 dark:text-amber-400">
        <MarkerIcon>
          <Clock3 className="text-amber-600 dark:text-amber-400" />
        </MarkerIcon>
        <MarkerContent>
          {hasProgress
            ? `Stopped after reaching ${limit}.`
            : `The response reached ${limit} before producing an answer.`}
        </MarkerContent>
      </Marker>
      {hasProgress && onContinue ? (
        <Button size="sm" onClick={onContinue} disabled={continuing}>
          <ArrowRight aria-hidden="true" />
          {continuing ? "Continuing…" : "Continue"}
        </Button>
      ) : null}
      {!hasProgress && onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
          <RotateCcw aria-hidden="true" />
          {retrying ? "Retrying…" : "Try again"}
        </Button>
      ) : null}
    </div>
  )
}

export function RunFailureMarker({
  onRetry,
  retrying = false,
}: {
  onRetry?: () => void
  retrying?: boolean
}) {
  return (
    <div className="flex flex-wrap items-center gap-2" role="status">
      <p className="text-sm text-muted-foreground">I couldn’t get a response started.</p>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
          <RotateCcw aria-hidden="true" />
          {retrying ? "Retrying…" : "Retry"}
        </Button>
      ) : null}
    </div>
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

export function UserFileAttachment({
  fileRef,
  document,
}: {
  fileRef: AgentFileRef
  document?: AgentDocumentSource
}) {
  return <FileAttachmentCard fileRef={fileRef} document={document} />
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

function formatTurnTimeout(timeoutMs: number | undefined): string {
  if (!timeoutMs || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return "the configured turn limit"
  }
  const units = [
    { label: "hour", ms: 60 * 60_000 },
    { label: "minute", ms: 60_000 },
    { label: "second", ms: 1_000 },
  ] as const
  for (const unit of units) {
    if (timeoutMs % unit.ms === 0) {
      const amount = timeoutMs / unit.ms
      return `the ${amount}-${unit.label} turn limit`
    }
  }
  return "the configured turn limit"
}

function textOf(message: AgentMessage): string {
  return message.parts
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim()
}

function filePartsOf(message: AgentMessage) {
  return message.parts.flatMap((part, index) =>
    part.type === "file" ? [{ part: part as Extract<typeof part, { type: "file" }>, index }] : []
  )
}

function contextPartsOf(message: AgentMessage): AgentContextEntryInput[] {
  return message.parts.flatMap((part) =>
    part.type === "context"
      ? [{ context: part.context as AgentContextInput, origin: part.origin }]
      : []
  )
}

function agentMessageDocumentSource(
  message: AgentMessage,
  partIndex: number
): AgentDocumentSource | undefined {
  const part = message.parts[partIndex]
  if (part?.type !== "file") return
  return createAgentDocumentSource({
    threadId: message.threadId,
    messageId: message.id,
    partIndex,
    fileRef: part.fileRef,
  })
}
