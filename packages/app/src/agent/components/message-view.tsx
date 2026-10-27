import {
  Bubble,
  BubbleContent,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Marker,
  MarkerContent,
  MarkerIcon,
} from "@sixb/ui/components"
import { AlertTriangle, ArrowRight, ChevronRight, Clock3, RotateCcw, Unplug } from "lucide-react"
import { memo, type ReactNode } from "react"
import type { FileSource } from "../../artifacts/file-source"
import { PersonAvatar } from "../../artifacts/person-avatar"
import type { AgentConversationMessage } from "../conversation"
import { useAgentMessages } from "../i18n"
import type { AgentMessages } from "../i18n/en"
import { type AuthorLabel, useMessageAuthors } from "../message-authors"
import { isContinuableDiagnostic } from "../run-presentation"
import type { AgentFileRef } from "../types"
import { ACTIVITY_STATUS_ROW_CLASS_NAME, ActivityStatusText } from "./activity-status"
import { AgentMessageBody } from "./agent-message-body"
import { ContextChips } from "./context-chips"
import { FileAttachmentCard } from "./file-attachment-card"

/**
 * Render a single message of the conversation. `continued`: the previous user message has the same
 * author, so this one does not name them. `onContinue` offers to finish an answer whose diagnostic
 * says it stopped short. `after` closes a reply, such as the notice of how its turn ended.
 */
export const MessageView = memo(function MessageView({
  message,
  continued = false,
  onContinue,
  continuing = false,
  after,
}: {
  readonly message: AgentConversationMessage
  readonly continued?: boolean
  readonly onContinue?: () => void
  readonly continuing?: boolean
  readonly after?: ReactNode
}) {
  if (message.role === "user") return <UserMessage message={message} continued={continued} />

  return (
    <AssistantMessage
      message={message}
      onContinue={onContinue}
      continuing={continuing}
      after={after}
    />
  )
})

function UserMessage({
  message,
  continued,
}: {
  readonly message: AgentConversationMessage
  readonly continued: boolean
}) {
  const authors = useMessageAuthors()
  const text = textOf(message)
  const files = message.parts.flatMap((part) => (part.type === "file" ? [part] : []))
  const pending = message.status === "pending"
  if (!text && files.length === 0 && message.context.length === 0) return null

  return (
    <div className="flex flex-col items-end gap-1.5">
      {continued ? null : <AuthorLine author={authors?.labelOf(message.author)} />}
      <ContextChips
        entries={message.context}
        className={pending ? "justify-end" : "max-w-[min(90%,40rem)] justify-end"}
      />
      {files.length > 0 ? (
        <div className="flex max-w-[min(80%,32rem)] flex-col items-end gap-1.5">
          {files.map((file, index) => (
            <UserFileAttachment key={index} fileRef={file.fileRef} source={file.source} />
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

function AssistantMessage({
  message,
  onContinue,
  continuing,
  after,
}: {
  readonly message: AgentConversationMessage
  readonly onContinue?: () => void
  readonly continuing: boolean
  readonly after?: ReactNode
}) {
  const messages = useAgentMessages()
  return (
    <div className="flex flex-col gap-2">
      {message.compaction ? <CompactionResult summary={message.compaction.summary} /> : null}
      <AgentMessageBody message={message} />
      {message.diagnostics.map((annotation, index) => (
        // Laid out like the timeout and interrupted markers: notice, then its action.
        <div
          key={`${annotation.code}:${index}`}
          className="flex flex-wrap items-center gap-2"
          role="status"
        >
          <Marker
            className={
              annotation.severity === "error"
                ? "text-destructive"
                : "text-amber-700 dark:text-amber-400"
            }
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
              {diagnosticMessage(annotation.code, messages.diagnostics)}
            </MarkerContent>
          </Marker>
          {onContinue && isContinuableDiagnostic(annotation.code) ? (
            <Button size="sm" onClick={onContinue} disabled={continuing}>
              <ArrowRight aria-hidden="true" />
              {continuing ? messages.transcript.continuing : messages.transcript.continue}
            </Button>
          ) : null}
        </div>
      ))}
      {after}
    </div>
  )
}

/** Who wrote a user message, where messages name their author. */
export function AuthorLine({ author }: { readonly author: AuthorLabel | undefined }) {
  if (!author) return null

  return (
    <p className="mt-2 flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
      <PersonAvatar name={author.name} size="xs" />
      <span>{author.label}</span>
    </p>
  )
}

function CompactionResult({ summary }: { summary: string }) {
  const messages = useAgentMessages().transcript
  return (
    <Collapsible className="max-w-full">
      <CollapsibleTrigger className="group flex w-fit max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-[13px] leading-normal text-muted-foreground outline-none transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <span>{messages.condensed}</span>
        <ChevronRight className="size-4 shrink-0 opacity-0 transition-[transform,opacity] group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[state=open]:rotate-90 group-data-[state=open]:opacity-100" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="scrollbar-thin mt-2 ml-1.5 max-h-[min(24rem,50vh)] overflow-y-auto overscroll-contain border-l-2 border-border py-0.5 pr-2 pl-3">
          <p className="text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground/80">
            {summary}
          </p>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

export function CompactionMarker() {
  const messages = useAgentMessages().transcript
  return (
    <Marker role="status" aria-label={messages.condensingLabel}>
      <MarkerContent className="shimmer">{messages.condensing}</MarkerContent>
    </Marker>
  )
}

export function ThinkingMarker({ takingLonger = false }: { takingLonger?: boolean }) {
  const messages = useAgentMessages().transcript
  return (
    <div className={ACTIVITY_STATUS_ROW_CLASS_NAME} role="status" aria-label={messages.working}>
      <ActivityStatusText
        label={takingLonger ? messages.takingLonger : messages.thinking}
        className="shimmer"
      />
    </div>
  )
}

export function RunCancelledMarker() {
  const messages = useAgentMessages().transcript
  return <p className="text-sm text-muted-foreground">{messages.stopped}</p>
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
  const messages = useAgentMessages().transcript
  const limit = formatTurnTimeout(timeoutMs, messages)
  return (
    <div className="flex flex-wrap items-center gap-2" role="status">
      <Marker className="text-amber-700 dark:text-amber-400">
        <MarkerIcon>
          <Clock3 className="text-amber-600 dark:text-amber-400" />
        </MarkerIcon>
        <MarkerContent>
          {hasProgress ? messages.stoppedAtLimit(limit) : messages.limitBeforeAnswer(limit)}
        </MarkerContent>
      </Marker>
      {hasProgress && onContinue ? (
        <Button size="sm" onClick={onContinue} disabled={continuing}>
          <ArrowRight aria-hidden="true" />
          {continuing ? messages.continuing : messages.continue}
        </Button>
      ) : null}
      {!hasProgress && onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
          <RotateCcw aria-hidden="true" />
          {retrying ? messages.retrying : messages.tryAgain}
        </Button>
      ) : null}
    </div>
  )
}

/** The worker running the turn stopped: continue from its saved progress, or run it again. */
export function RunInterruptedMarker({
  hasProgress,
  onRetry,
  onContinue,
  retrying = false,
  continuing = false,
}: {
  hasProgress: boolean
  onRetry?: () => void
  onContinue?: () => void
  retrying?: boolean
  continuing?: boolean
}) {
  const messages = useAgentMessages().transcript
  return (
    <div className="flex flex-wrap items-center gap-2" role="status">
      <Marker className="text-amber-700 dark:text-amber-400">
        <MarkerIcon>
          <Unplug className="text-amber-600 dark:text-amber-400" />
        </MarkerIcon>
        <MarkerContent>{messages.interrupted}</MarkerContent>
      </Marker>
      {hasProgress && onContinue ? (
        <Button size="sm" onClick={onContinue} disabled={continuing}>
          <ArrowRight aria-hidden="true" />
          {continuing ? messages.continuing : messages.continue}
        </Button>
      ) : null}
      {!hasProgress && onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
          <RotateCcw aria-hidden="true" />
          {retrying ? messages.retrying : messages.tryAgain}
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
  const messages = useAgentMessages().transcript
  return (
    <div className="flex flex-wrap items-center gap-2" role="status">
      <p className="text-sm text-muted-foreground">{messages.notStarted}</p>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
          <RotateCcw aria-hidden="true" />
          {retrying ? messages.retrying : messages.retry}
        </Button>
      ) : null}
    </div>
  )
}

/** Shown while an active run's stream has dropped and the client is re-subscribing. */
export function ReconnectingMarker() {
  const messages = useAgentMessages().transcript
  return (
    <Marker role="status" aria-label={messages.reconnectingLabel}>
      <MarkerContent className="shimmer">{messages.reconnecting}</MarkerContent>
    </Marker>
  )
}

export function UserFileAttachment({
  fileRef,
  source,
}: {
  fileRef: AgentFileRef
  source?: FileSource
}) {
  return <FileAttachmentCard fileRef={fileRef} source={source} />
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

function formatTurnTimeout(
  timeoutMs: number | undefined,
  messages: AgentMessages["transcript"]
): string {
  if (!timeoutMs || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return messages.turnLimit
  const units = [
    { label: "hour", ms: 60 * 60_000 },
    { label: "minute", ms: 60_000 },
    { label: "second", ms: 1_000 },
  ] as const
  for (const unit of units) {
    if (timeoutMs % unit.ms === 0) return messages.turnLimitOf(timeoutMs / unit.ms, unit.label)
  }
  return messages.turnLimit
}

/** Diagnostics carry a stable code; their English `message` is for developers and logs. */
function diagnosticMessage(code: string, messages: AgentMessages["diagnostics"]): string {
  return Object.hasOwn(messages, code)
    ? messages[code as keyof AgentMessages["diagnostics"]]
    : messages.unknown
}

/** A user message's text, as one bubble. */
function textOf(message: AgentConversationMessage): string {
  return message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim()
}
