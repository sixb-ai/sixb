import { client } from "@sixb/client"
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
  Bubble,
  BubbleContent,
  Marker,
  MarkerContent,
  MarkerIcon,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { AlertTriangle, File as FileIcon, FileImage, FileText, Table2 } from "lucide-react"
import { isAwaitingFirstToken, type LiveRunState } from "../liveRun"
import { normalizeDurableParts } from "../parts"
import type { AgentFileRef, AgentMessage } from "../types"
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
  return <AssistantBody parts={normalizeDurableParts(message.parts)} />
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
  const fileName = fileRef.fileName?.trim() || "File"
  const mediaLabel = fileMediaLabel(fileRef.mediaType, fileName)
  const { Icon, className } = fileIconPresentation(fileRef.mediaType, fileName)

  return (
    <Attachment
      size="sm"
      state="done"
      className="w-[20rem] max-w-[80vw] rounded-2xl border-border/70 bg-background shadow-sm"
    >
      {href ? (
        <AttachmentTrigger asChild>
          <a href={href} target="_blank" rel="noreferrer" aria-label={`Open ${fileName}`} />
        </AttachmentTrigger>
      ) : null}
      <AttachmentMedia className={cn("size-9 rounded-xl bg-muted/80", className)}>
        <Icon className="size-4.5" />
      </AttachmentMedia>
      <AttachmentContent className="min-w-0 py-0 pr-2">
        <AttachmentTitle className="text-sm font-medium" title={fileName}>
          {fileName}
        </AttachmentTitle>
        <AttachmentDescription className="text-xs" title={fileRef.digest}>
          {mediaLabel} · {formatFileSize(fileRef.sizeBytes)}
        </AttachmentDescription>
      </AttachmentContent>
    </Attachment>
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

function filePartsOf(message: AgentMessage) {
  return message.parts.flatMap((part, index) =>
    part.type === "file" ? [{ part: part as Extract<typeof part, { type: "file" }>, index }] : []
  )
}

function fileMediaLabel(mediaType: string | undefined, fileName: string): string {
  const normalized = mediaType?.trim().toLowerCase()
  const lowerName = fileName.toLowerCase()
  if (
    normalized?.includes("spreadsheet") ||
    normalized?.includes("csv") ||
    /\.(csv|tsv|xls|xlsx)$/i.test(lowerName)
  ) {
    return "Spreadsheet"
  }
  if (normalized === "application/pdf" || lowerName.endsWith(".pdf")) return "PDF"
  if (normalized?.startsWith("image/")) return "Image"
  if (normalized === "text/markdown" || lowerName.endsWith(".md")) return "Markdown"
  if (normalized === "text/plain" || lowerName.endsWith(".txt")) return "Text"
  if (normalized?.startsWith("text/")) return "Document"
  if (normalized) return normalized
  return "File"
}

function formatFileSize(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return "Unknown size"

  const units = ["B", "KB", "MB", "GB", "TB"] as const
  let value = sizeBytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  const maximumFractionDigits = unitIndex === 0 || value >= 10 ? 0 : 1
  return `${value.toLocaleString(undefined, { maximumFractionDigits })} ${units[unitIndex]}`
}

function fileIconPresentation(mediaType: string | undefined, fileName: string) {
  const normalized = mediaType?.trim().toLowerCase()
  const lowerName = fileName.toLowerCase()

  if (
    normalized?.includes("spreadsheet") ||
    normalized?.includes("csv") ||
    /\.(csv|tsv|xls|xlsx)$/i.test(lowerName)
  ) {
    return { Icon: Table2, className: "bg-emerald-500 text-white" }
  }
  if (normalized?.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(lowerName)) {
    return { Icon: FileImage, className: "bg-sky-500/[0.08] text-sky-600 dark:text-sky-300" }
  }
  if (normalized === "application/pdf" || lowerName.endsWith(".pdf")) {
    return { Icon: FileText, className: "bg-rose-500/[0.08] text-rose-600 dark:text-rose-300" }
  }
  if (normalized?.startsWith("text/") || /\.(txt|md|json|yaml|yml)$/i.test(lowerName)) {
    return { Icon: FileText, className: "bg-muted text-muted-foreground" }
  }
  return { Icon: FileIcon, className: "bg-muted text-muted-foreground" }
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
