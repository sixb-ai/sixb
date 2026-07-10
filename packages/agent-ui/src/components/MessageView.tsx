import { client } from "@sixb/client"
import { Bubble, BubbleContent, Marker, MarkerContent, MarkerIcon } from "@sixb/ui/components"
import { AlertTriangle } from "lucide-react"
import { isAwaitingFirstToken, type LiveRunState } from "../liveRun"
import { normalizeDurableParts } from "../parts"
import type { AgentFileRef, AgentMessage } from "../types"
import { FileAttachmentCard } from "./FileAttachmentCard"
import { AssistantBody } from "./MessageParts"

/** Render a single durable message. System messages are not shown in the reading transcript. */
export function MessageView({ message }: { message: AgentMessage }) {
  if (message.role === "user") return <UserMessage message={message} />
  if (message.role === "assistant") return <AssistantMessage message={message} />
  return null
}

function UserMessage({ message }: { message: AgentMessage }) {
  const text = textOf(message)
  const files = filePartsOf(message)
  if (!text && files.length === 0) return null
  return (
    <div className="flex flex-col items-end gap-1.5">
      {files.length > 0 ? (
        <div className="flex max-w-[min(80%,32rem)] flex-col items-end gap-1.5">
          {files.map(({ part, index }) => (
            <UserFileAttachment
              key={index}
              fileRef={part.fileRef}
              href={agentMessageFileContentHref(message, index, "inline")}
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
          fileHref: (partIndex) => agentMessageFileContentHref(message, partIndex, "inline"),
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
export function LiveAssistant({ live }: { live: LiveRunState }) {
  if (isAwaitingFirstToken(live)) {
    return <ThinkingMarker />
  }

  return (
    <div className="flex flex-col gap-2">
      <AssistantBody parts={live.parts} live={live.active} />
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

export function UserFileAttachment({ fileRef, href }: { fileRef: AgentFileRef; href?: string }) {
  return <FileAttachmentCard fileRef={fileRef} href={href} />
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

function filePartsOf(message: AgentMessage) {
  return message.parts.flatMap((part, index) =>
    part.type === "file" ? [{ part: part as Extract<typeof part, { type: "file" }>, index }] : []
  )
}

function agentMessageFileContentHref(
  message: AgentMessage,
  partIndex: number,
  disposition: "inline" | "attachment"
): string {
  const params = new URLSearchParams({
    path: `/parts/${partIndex}/fileRef`,
    disposition,
  })
  const routePath = `/api/agent-threads/${encodeURIComponent(message.threadId)}/messages/${encodeURIComponent(
    message.id
  )}/files/content`
  const baseUrl = client.getConfig().baseUrl
  if (!baseUrl && typeof window === "undefined") {
    return `${routePath}?${params}`
  }

  const url = new URL(routePath, baseUrl ?? window.location.origin)
  url.search = params.toString()
  return url.toString()
}
