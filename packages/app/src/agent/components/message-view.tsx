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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@sixb/ui/components"
import { useLocale } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronRight,
  Clock3,
  Cloud,
  Copy,
  File as FileIcon,
  Folder,
  Info,
  type LucideIcon,
  Pencil,
  Plus,
  RotateCcw,
  Unplug,
  X,
} from "lucide-react"
import {
  type KeyboardEvent,
  memo,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import type { FileSource } from "../../artifacts/file-source"
import type { AgentConversationMessage } from "../conversation"
import { formatMessageTimeAgo, formatMessageTimestamp } from "../format"
import type { AgentMessageEditDraft } from "../hooks/use-agent-conversation"
import { useAgentMessages } from "../i18n"
import type { AgentMessages } from "../i18n/en"
import { riseFromTray } from "../inbox-handoff"
import { type AuthorLabel, useMessageAuthors } from "../message-authors"
import { isContinuableDiagnostic } from "../run-presentation"
import type { AgentContextEntryInput, AgentFileRef } from "../types"
import { ACTIVITY_STATUS_ROW_CLASS_NAME, ActivityStatusText } from "./activity-status"
import { AgentMessageBody } from "./agent-message-body"
import {
  COMPOSER_CHIP_CLASS_NAME,
  COMPOSER_CHIP_REMOVE_CLASS_NAME,
  COMPOSER_CHIP_THUMB_CLASS_NAME,
  ContextChips,
} from "./context-chips"
import { FileAttachmentCard } from "./file-attachment-card"

/**
 * Render a single message of the conversation. `continued`: the previous user message has the same
 * author, so this one does not name them. `onContinue` offers to finish an answer whose diagnostic
 * says it stopped short. `after` closes a reply, such as the notice of how its turn ended.
 */
export const MessageView = memo(function MessageView({
  message,
  continued = false,
  canEdit = false,
  editing = null,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onContinue,
  continuing = false,
  after,
}: {
  readonly message: AgentConversationMessage
  readonly continued?: boolean
  readonly canEdit?: boolean
  readonly editing?: AgentMessageEditDraft | null
  readonly onStartEdit?: (messageId: string) => void
  readonly onCancelEdit?: () => void
  readonly onSubmitEdit?: (
    messageId: string,
    text: string,
    attachments: readonly AgentFileRef[],
    context: readonly AgentContextEntryInput[]
  ) => void
  readonly onContinue?: () => void
  readonly continuing?: boolean
  readonly after?: ReactNode
}) {
  if (message.role === "user") {
    return (
      <UserMessage
        message={message}
        continued={continued}
        canEdit={canEdit}
        editing={editing}
        onStartEdit={onStartEdit}
        onCancelEdit={onCancelEdit}
        onSubmitEdit={onSubmitEdit}
      />
    )
  }

  return (
    <AssistantMessage
      message={message}
      onContinue={onContinue}
      continuing={continuing}
      after={after}
    />
  )
})

const USER_ACTION_BUTTON_CLASS_NAME = cn(
  "flex size-6 items-center justify-center rounded-md text-muted-foreground/80 outline-none transition-colors",
  "hover:bg-muted/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
)

const EDIT_MAX_HEIGHT_PX = 240

function UserMessage({
  message,
  continued,
  canEdit,
  editing,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
}: {
  readonly message: AgentConversationMessage
  readonly continued: boolean
  readonly canEdit: boolean
  readonly editing: AgentMessageEditDraft | null
  readonly onStartEdit?: (messageId: string) => void
  readonly onCancelEdit?: () => void
  readonly onSubmitEdit?: (
    messageId: string,
    text: string,
    attachments: readonly AgentFileRef[],
    context: readonly AgentContextEntryInput[]
  ) => void
}) {
  const authors = useMessageAuthors()
  const agentMessages = useAgentMessages()
  const labels = agentMessages.transcript
  const locale = useLocale()
  const text = textOf(message)
  const files = message.parts.flatMap((part) => (part.type === "file" ? [part] : []))
  const pending = message.status === "pending"
  const ref = useRef<HTMLDivElement>(null)

  // A message the turn just read comes from the tray into its place; its saved copy, which keeps
  // the row, stays put.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only as it first appears
  useLayoutEffect(() => {
    if (message.status === "streaming" && ref.current) riseFromTray(ref.current, message.key)
  }, [])

  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1_600)
    return () => window.clearTimeout(timer)
  }, [copied])

  // A touch screen has no hover: touching the message shows its time and actions, and touching
  // anywhere else puts them away.
  const [touched, setTouched] = useState(false)

  useEffect(() => {
    if (!touched) return
    const away = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setTouched(false)
    }
    document.addEventListener("pointerdown", away)
    return () => document.removeEventListener("pointerdown", away)
  }, [touched])

  if (!text && files.length === 0 && message.context.length === 0 && !editing) return null

  if (editing && message.id && onSubmitEdit && onCancelEdit) {
    return (
      <div data-user-message="" className="flex flex-col items-end gap-1.5">
        {continued ? null : <AuthorLine author={authors?.labelOf(message.author)} />}
        <UserMessageEditor
          key={`${editing.messageId}:${editing.nonce}`}
          draft={editing}
          onCancel={onCancelEdit}
          onSubmit={(nextText, nextAttachments, nextContext) =>
            onSubmitEdit(editing.messageId, nextText, nextAttachments, nextContext)
          }
        />
      </div>
    )
  }

  const messageId = message.id
  const showEdit = Boolean(!pending && canEdit && messageId && onStartEdit)
  const showCopy = !pending && text.length > 0
  const age = !pending
    ? formatMessageTimeAgo(message.createdAt, locale, agentMessages.contextMeter.justNow)
    : ""
  const timestampTitle = !pending ? formatMessageTimestamp(message.createdAt, locale) : ""
  const showHoverBar = !pending && Boolean(age || showEdit || showCopy)

  const handleCopy = () => {
    if (!text) return
    void navigator.clipboard?.writeText(text).then(
      () => setCopied(true),
      () => {}
    )
  }

  return (
    <div
      ref={ref}
      data-user-message=""
      className="group/user-message flex flex-col items-end gap-1.5"
      onPointerUp={(event) => {
        if (event.pointerType !== "mouse") setTouched(true)
      }}
    >
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
          <BubbleContent className="rounded-2xl px-3.5 py-2 text-[15px] whitespace-pre-wrap">
            {text}
          </BubbleContent>
        </Bubble>
      ) : null}
      {showHoverBar ? (
        <TooltipProvider delayDuration={300}>
          <div
            data-user-message-actions=""
            data-visible={copied || touched || undefined}
            className={cn(
              "-mt-0.5 -mb-4 flex h-6 items-center justify-end gap-0.5 pr-0.5 select-none",
              "pointer-events-none opacity-0 transition-opacity duration-150 ease-out",
              "group-hover/user-message:pointer-events-auto group-hover/user-message:opacity-100",
              "group-focus-within/user-message:pointer-events-auto group-focus-within/user-message:opacity-100",
              "data-[visible]:pointer-events-auto data-[visible]:opacity-100"
            )}
          >
            {age ? (
              <span
                data-user-message-age=""
                title={timestampTitle || undefined}
                className="mr-1.5 text-xs text-muted-foreground/80 tabular-nums"
              >
                {age}
              </span>
            ) : null}
            {showEdit && messageId && onStartEdit ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => onStartEdit(messageId)}
                    aria-label={labels.editMessage}
                    className={USER_ACTION_BUTTON_CLASS_NAME}
                  >
                    <Pencil className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{labels.editMessage}</TooltipContent>
              </Tooltip>
            ) : null}
            {showCopy ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handleCopy}
                    aria-label={copied ? labels.copiedMessage : labels.copyMessage}
                    className={USER_ACTION_BUTTON_CLASS_NAME}
                  >
                    {copied ? (
                      <Check
                        className="size-3.5 text-foreground"
                        strokeWidth={2}
                        aria-hidden="true"
                      />
                    ) : (
                      <Copy className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {copied ? labels.copiedMessage : labels.copyMessage}
                </TooltipContent>
              </Tooltip>
            ) : null}
          </div>
        </TooltipProvider>
      ) : null}
    </div>
  )
}

function UserMessageEditor({
  draft,
  onCancel,
  onSubmit,
}: {
  readonly draft: AgentMessageEditDraft
  readonly onCancel: () => void
  readonly onSubmit: (
    text: string,
    attachments: readonly AgentFileRef[],
    context: readonly AgentContextEntryInput[]
  ) => void
}) {
  const agentMessages = useAgentMessages()
  const labels = agentMessages.transcript
  const [value, setValue] = useState(draft.text)
  const [attachments, setAttachments] = useState<readonly AgentFileRef[]>(draft.attachments)
  const [contextEntries, setContextEntries] = useState<readonly AgentContextEntryInput[]>(
    draft.context
  )
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure height whenever the text changes
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.overflowY = el.scrollHeight > EDIT_MAX_HEIGHT_PX ? "auto" : "hidden"
    el.style.height = `${Math.min(el.scrollHeight, EDIT_MAX_HEIGHT_PX)}px`
  }, [value])

  const canSave = value.trim().length > 0 || attachments.length > 0

  const submit = () => {
    if (!canSave) return
    onSubmit(value.trim(), attachments, contextEntries)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter and Escape confirm or dismiss the input method's candidate while one is open; Safari
    // reports that keydown with keyCode 229 rather than `isComposing`.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === "Escape") {
      event.preventDefault()
      onCancel()
      return
    }
    if (event.key !== "Enter" || event.shiftKey) return
    event.preventDefault()
    if (event.metaKey || event.ctrlKey) {
      const el = textareaRef.current
      const start = el?.selectionStart ?? value.length
      const end = el?.selectionEnd ?? value.length
      setValue((current) => `${current.slice(0, start)}\n${current.slice(end)}`)
      requestAnimationFrame(() => {
        el?.setSelectionRange(start + 1, start + 1)
      })
      return
    }
    submit()
  }

  return (
    <div data-user-message-editor="" className="flex w-full flex-col items-end gap-2">
      <div
        className={cn(
          "flex w-full max-w-[min(85%,42rem)] flex-col gap-2 rounded-2xl bg-background px-3.5 py-2.5",
          "ring-1 ring-[#007aff] shadow-[0_1px_2px_rgb(0_0_0/0.04)] dark:ring-[#0a84ff]"
        )}
      >
        {contextEntries.length > 0 || attachments.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            <ContextChips
              entries={contextEntries}
              onRemove={(index) =>
                setContextEntries((current) =>
                  current.filter((_, candidateIndex) => candidateIndex !== index)
                )
              }
              className="contents"
            />
            {attachments.map((fileRef, index) => (
              <span
                key={`${fileRef.blobId}:${index}`}
                className={cn(COMPOSER_CHIP_CLASS_NAME, "pr-1.5")}
                title={fileRef.fileName}
              >
                <span className={COMPOSER_CHIP_THUMB_CLASS_NAME}>
                  <FileIcon className="size-3" strokeWidth={2} aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {fileRef.fileName || agentMessages.files.file}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setAttachments((current) =>
                      current.filter((_, candidateIndex) => candidateIndex !== index)
                    )
                  }
                  aria-label={
                    fileRef.fileName
                      ? agentMessages.composer.removeAttachment(fileRef.fileName)
                      : agentMessages.composer.removeUnnamedAttachment
                  }
                  className={COMPOSER_CHIP_REMOVE_CLASS_NAME}
                >
                  <X className="size-[11px]" strokeWidth={2.6} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          aria-label={labels.editMessage}
          placeholder={agentMessages.composer.placeholder}
          className="min-h-6 max-h-[240px] w-full resize-none bg-transparent text-[15px] leading-relaxed text-foreground outline-none [field-sizing:content] placeholder:text-muted-foreground"
        />
      </div>
      <div className="flex items-center justify-end gap-1.5">
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={labels.editInfo}
                className="flex size-7 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <Info className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-64 text-xs">
              {labels.editInfo}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <button
          type="button"
          onClick={onCancel}
          className="h-7 rounded-lg px-2.5 text-[13px] font-medium text-foreground/80 outline-none transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {labels.cancelEdit}
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!canSave}
          className={cn(
            "h-7 rounded-lg px-3 text-[13px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
            "bg-foreground text-background hover:bg-foreground/85",
            "disabled:pointer-events-none disabled:bg-muted disabled:text-muted-foreground"
          )}
        >
          {labels.saveEdit}
        </button>
      </div>
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
      {message.compaction ? (
        <CompactionResult
          summary={message.compaction.summary}
          contextFull={message.compaction.reason === "overflow"}
        />
      ) : null}
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

  return <p className="mt-2 px-1 text-xs text-muted-foreground">{author.label}</p>
}

/** The summary the run condensed the conversation into; why, when the context was full. */
function CompactionResult({
  summary,
  contextFull,
}: {
  readonly summary: string
  readonly contextFull: boolean
}) {
  const messages = useAgentMessages().transcript
  return (
    <Collapsible className="max-w-full">
      <CollapsibleTrigger className="group flex w-fit max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-[13px] leading-normal text-muted-foreground outline-none transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <span>{contextFull ? messages.condensedFull : messages.condensed}</span>
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

/** Condensing under way; to let the turn go on when the provider refused a request as too long. */
export function CompactionMarker({ contextFull = false }: { readonly contextFull?: boolean }) {
  const messages = useAgentMessages().transcript
  return (
    <Marker role="status" aria-label={messages.condensingLabel}>
      <MarkerContent className="shimmer">
        {contextFull ? messages.condensingFull : messages.condensing}
      </MarkerContent>
    </Marker>
  )
}

export function ThinkingMarker({
  takingLonger = false,
  waitingFor = null,
}: {
  takingLonger?: boolean
  /** The offline computer the turn waits for. */
  waitingFor?: string | null
}) {
  const messages = useAgentMessages()
  const label = waitingFor
    ? messages.computer.waitingFor(waitingFor)
    : takingLonger
      ? messages.transcript.takingLonger
      : messages.transcript.thinking
  return (
    <div
      className={ACTIVITY_STATUS_ROW_CLASS_NAME}
      role="status"
      aria-label={messages.transcript.working}
    >
      <ActivityStatusText label={label} className="shimmer" />
    </div>
  )
}

/**
 * Where the conversation moved: the files earlier turns worked on stayed behind. Set apart, with
 * where it went as its icon, so it reads as an event of the conversation, not the reply's end.
 */
export function MovedMarker({
  label,
  place = "computer",
}: {
  readonly label: string
  readonly place?: "cloud" | "computer"
}) {
  const Icon = place === "cloud" ? Cloud : Folder
  return (
    <Marker role="note" className="mt-2 items-start text-[13px]">
      <MarkerIcon className="mt-px flex size-4 items-center justify-center">
        <Icon className="size-3.5" strokeWidth={1.9} />
      </MarkerIcon>
      <MarkerContent>{label}</MarkerContent>
    </Marker>
  )
}

/**
 * How a turn ended short of a full answer: one quiet line, its icon tinted by what happened, and at
 * most one way on. Every ending reads the same way, so only the words and the icon change.
 */
function TurnNotice({
  icon: Icon,
  tone = "warning",
  children,
  action,
}: {
  icon?: LucideIcon
  tone?: "warning" | "error"
  children: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2" role="status">
      {/* The icon sits on the first line of a notice that wraps: 2px centers 16px on 20px. */}
      <p className="flex min-w-0 items-start gap-2 text-sm leading-5 text-muted-foreground">
        {Icon ? (
          <Icon
            aria-hidden="true"
            className={cn(
              "mt-0.5 size-4 shrink-0",
              tone === "error" ? "text-destructive" : "text-amber-600 dark:text-amber-400"
            )}
          />
        ) : null}
        <span>{children}</span>
      </p>
      {action}
    </div>
  )
}

function TurnAction({
  icon: Icon,
  label,
  onClick,
  disabled,
}: {
  icon: LucideIcon
  label: string
  onClick: () => void
  disabled: boolean
}) {
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={onClick}
      disabled={disabled}
      className="h-8 rounded-full px-3"
    >
      <Icon aria-hidden="true" />
      {label}
    </Button>
  )
}

/** A turn cut short goes on from what it saved, or runs again when it saved nothing. */
function PickUpAction({
  hasProgress,
  onRetry,
  onContinue,
  retrying,
  continuing,
}: {
  hasProgress: boolean
  onRetry?: () => void
  onContinue?: () => void
  retrying: boolean
  continuing: boolean
}) {
  const messages = useAgentMessages().transcript
  if (hasProgress && onContinue) {
    return (
      <TurnAction
        icon={ArrowRight}
        label={continuing ? messages.continuing : messages.continue}
        onClick={onContinue}
        disabled={continuing}
      />
    )
  }
  if (!hasProgress && onRetry) {
    return (
      <TurnAction
        icon={RotateCcw}
        label={retrying ? messages.retrying : messages.tryAgain}
        onClick={onRetry}
        disabled={retrying}
      />
    )
  }
  return null
}

export function RunCancelledMarker() {
  const messages = useAgentMessages().transcript
  return <TurnNotice>{messages.stopped}</TurnNotice>
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
    <TurnNotice
      icon={Clock3}
      action={
        <PickUpAction
          hasProgress={hasProgress}
          onRetry={onRetry}
          onContinue={onContinue}
          retrying={retrying}
          continuing={continuing}
        />
      }
    >
      {hasProgress ? messages.stoppedAtLimit(limit) : messages.limitBeforeAnswer(limit)}
    </TurnNotice>
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
    <TurnNotice
      icon={Unplug}
      action={
        <PickUpAction
          hasProgress={hasProgress}
          onRetry={onRetry}
          onContinue={onContinue}
          retrying={retrying}
          continuing={continuing}
        />
      }
    >
      {messages.interrupted}
    </TurnNotice>
  )
}

export function RunFailureMarker({
  onRetry,
  retrying = false,
  contextFull = false,
  onNewThread,
}: {
  onRetry?: () => void
  retrying?: boolean
  /**
   * The conversation is too long for its model: running it again would fail the same way, so the
   * way on is a new thread.
   */
  contextFull?: boolean
  onNewThread?: () => void
}) {
  const labels = useAgentMessages()
  const messages = labels.transcript
  return (
    <TurnNotice
      icon={AlertTriangle}
      tone="error"
      action={
        contextFull ? (
          onNewThread ? (
            <TurnAction
              icon={Plus}
              label={labels.threads.new}
              onClick={onNewThread}
              disabled={false}
            />
          ) : null
        ) : onRetry ? (
          <TurnAction
            icon={RotateCcw}
            label={retrying ? messages.retrying : messages.retry}
            onClick={onRetry}
            disabled={retrying}
          />
        ) : null
      }
    >
      {contextFull ? messages.contextFull : messages.notStarted}
    </TurnNotice>
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

export function RunErrorMarker({
  message,
  onContinue,
  continuing = false,
}: {
  message: string
  onContinue?: () => void
  continuing?: boolean
}) {
  const messages = useAgentMessages().transcript
  return (
    <TurnNotice
      icon={AlertTriangle}
      tone="error"
      action={
        onContinue ? (
          <TurnAction
            icon={ArrowRight}
            label={continuing ? messages.continuing : messages.continue}
            onClick={onContinue}
            disabled={continuing}
          />
        ) : null
      }
    >
      {message}
    </TurnNotice>
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
