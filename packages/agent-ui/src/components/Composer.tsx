import { searchObjectsOptions, useUploadFile } from "@sixb/client/hooks"
import type { AgentReasoningLevel } from "@sixb/core"
import {
  type AgentContextEntryInput,
  type AgentContextInput,
  agentContextFingerprint,
  agentContextIdentity,
  MAX_AGENT_CONTEXT_ENTRIES,
} from "@sixb/core/agents/context"
import { Marker, MarkerContent, MarkerIcon, Spinner, Textarea } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { useQuery } from "@tanstack/react-query"
import {
  AlertTriangle,
  ArrowUp,
  File as FileIcon,
  FileText,
  Image as ImageIcon,
  Plus,
  Square,
  Table2,
  UploadCloud,
  X,
} from "lucide-react"
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { createPortal } from "react-dom"
import type { AgentFileRef, LanguageModel } from "../types"
import { agentContextLabel, mergeAgentContext } from "../utils/contextDisplay"
import {
  type AgentContextMention,
  findAgentContextMention,
  removeAgentContextMention,
} from "../utils/contextMention"
import { ContextChips } from "./ContextChips"
import { ContextPicker } from "./ContextPicker"
import { ModelControls } from "./ModelControls"

export interface ComposerProps {
  readonly onSend: (
    text: string,
    attachments: readonly AgentFileRef[],
    context: readonly AgentContextEntryInput[]
  ) => void
  readonly disabled?: boolean
  readonly pending?: boolean
  /** A run is in flight: the send button becomes a stop button that calls {@link onStop}. */
  readonly running?: boolean
  /** A stop has been requested and we're waiting for the run to end. */
  readonly stopping?: boolean
  readonly onStop?: () => void
  readonly models?: readonly LanguageModel[]
  readonly selectedModel?: LanguageModel
  readonly selectedReasoning?: AgentReasoningLevel
  readonly modelsLoading?: boolean
  readonly modelsError?: boolean
  readonly onSelectModel?: (model: LanguageModel) => void
  readonly onSelectReasoning?: (reasoning: AgentReasoningLevel) => void
  readonly placeholder?: string
  /** Optional classes for the composer shell. */
  readonly className?: string
  /** Optional status line shown under the input, e.g. while a run is active. */
  readonly hint?: string
  /** A failed send, kept within the same width constraint as the input. */
  readonly error?: string
  /**
   * Text to restore into the input, e.g. after a failed send so the user does not lose it.
   * Applied whenever `draftNonce` changes to a non-zero value, so re-sending the same text works.
   */
  readonly draft?: string
  readonly draftAttachments?: readonly AgentFileRef[]
  /** Exact context snapshot to restore after a failed send. */
  readonly draftContext?: readonly AgentContextEntryInput[]
  readonly draftNonce?: number
  /** Ambient context offered for the next turn. Explicit @ selections remain composer-local. */
  readonly ambientContext?: readonly AgentContextInput[]
  /** Scope drag/drop and overlays to an embedded panel instead of the whole viewport. */
  readonly compact?: boolean
}

type ComposerAttachment =
  | {
      readonly id: string
      readonly status: "uploading"
      readonly fileName: string
      readonly mediaType?: string
      readonly sizeBytes: number
    }
  | {
      readonly id: string
      readonly status: "ready"
      readonly fileRef: AgentFileRef
    }
  | {
      readonly id: string
      readonly status: "error"
      readonly fileName: string
      readonly mediaType?: string
      readonly sizeBytes: number
      readonly error: string
    }

const MAX_HEIGHT_PX = 200

export function composerCanFocus({
  disabled,
  pending,
  running,
}: Pick<ComposerProps, "disabled" | "pending" | "running">): boolean {
  return !disabled && !pending && !running
}

export function Composer({
  onSend,
  disabled,
  pending,
  running,
  stopping,
  onStop,
  models = [],
  selectedModel,
  selectedReasoning,
  modelsLoading,
  modelsError,
  onSelectModel,
  onSelectReasoning,
  placeholder,
  className,
  hint,
  error,
  draft,
  draftAttachments,
  draftContext,
  draftNonce,
  ambientContext = [],
  compact = false,
}: ComposerProps) {
  const [value, setValue] = useState("")
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [contextEntries, setContextEntries] = useState<AgentContextEntryInput[]>(() =>
    ambientContext.map((context) => ({ context, origin: "ambient" }))
  )
  const [mention, setMention] = useState<AgentContextMention | null>(null)
  const [dismissedMention, setDismissedMention] = useState<string | null>(null)
  const [activeContextResult, setActiveContextResult] = useState(0)
  const [draggingFiles, setDraggingFiles] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragDepthRef = useRef(0)
  const uploadFile = useUploadFile()
  const wasRunningRef = useRef(Boolean(running))
  const dismissedAmbientRef = useRef(new Set<string>())
  const ambientKey = JSON.stringify(ambientContext.map(agentContextFingerprint))

  const mentionQuery = mention?.query.trim() ?? ""
  const contextSearch = useQuery({
    ...searchObjectsOptions({ query: { q: mentionQuery || "_", limit: "20" } }),
    enabled: mention !== null && mentionQuery.length > 0,
  })
  const contextResults = useMemo(() => {
    if (!mention || mention.query.trim().length === 0) return []
    const normalizedQuery = mention.query.trim().toLowerCase()
    const local = ambientContext.filter((context) =>
      agentContextLabel(context).toLowerCase().includes(normalizedQuery)
    )
    const remote = (contextSearch.data?.items ?? []).map(
      (item) => ({ kind: "object", ref: item.ref }) as const satisfies AgentContextInput
    )
    return mergeAgentContext(local, remote).map((context) => ({
      context,
      label:
        contextSearch.data?.items.find(
          (item) =>
            agentContextIdentity({ kind: "object", ref: item.ref }) ===
            agentContextIdentity(context)
        )?.label ?? agentContextLabel(context),
    }))
  }, [ambientContext, contextSearch.data?.items, mention])

  const uploading = attachments.some((attachment) => attachment.status === "uploading")
  const readyAttachments = attachments.flatMap((attachment) =>
    attachment.status === "ready" ? [attachment.fileRef] : []
  )
  const failedCount = attachments.filter((attachment) => attachment.status === "error").length
  const canAttachFiles = !disabled && !pending
  const canSend =
    value.trim().length > 0 &&
    mention === null &&
    !disabled &&
    !pending &&
    !uploading &&
    failedCount === 0

  // Reconcile page context by canonical identity. A removed ambient chip stays removed for the
  // current draft, while explicit @ selections survive unrelated page-context updates.
  // biome-ignore lint/correctness/useExhaustiveDependencies: ambientKey is the semantic dependency
  useEffect(() => {
    const ambientIdentities = new Set(ambientContext.map(agentContextIdentity))
    dismissedAmbientRef.current = new Set(
      [...dismissedAmbientRef.current].filter((identity) => ambientIdentities.has(identity))
    )
    setContextEntries((current) => {
      const explicit = current.filter((entry) => entry.origin === "explicit")
      const explicitIdentities = new Set(
        explicit.map((entry) => agentContextIdentity(entry.context))
      )
      const ambient = ambientContext
        .filter((context) => !dismissedAmbientRef.current.has(agentContextIdentity(context)))
        .filter((context) => !explicitIdentities.has(agentContextIdentity(context)))
        .map((context) => ({ context, origin: "ambient" as const }))
      return [...ambient, ...explicit]
    })
  }, [ambientKey])

  // Reseed the input on demand (a failed send hands the text and already-uploaded attachments back).
  // Keyed on the nonce so restoring the same draft twice still fires; ignored on mount (nonce 0) so
  // it never clobbers a fresh draft.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reseed only when the nonce changes
  useEffect(() => {
    if (!draftNonce) return
    setValue(draft ?? "")
    setAttachments(
      (draftAttachments ?? []).map((fileRef) => ({
        id: attachmentId(),
        status: "ready",
        fileRef,
      }))
    )
    const restoredContext = [...(draftContext ?? [])]
    setContextEntries(restoredContext)
    const restoredIdentities = new Set(
      restoredContext.map((entry) => agentContextIdentity(entry.context))
    )
    dismissedAmbientRef.current = new Set(
      ambientContext
        .map(agentContextIdentity)
        .filter((identity) => !restoredIdentities.has(identity))
    )
    setMention(null)
    textareaRef.current?.focus()
  }, [draftNonce])

  useEffect(() => {
    const wasRunning = wasRunningRef.current
    wasRunningRef.current = Boolean(running)
    if (!wasRunning || !composerCanFocus({ disabled, pending, running })) return

    const frame = requestAnimationFrame(() => textareaRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [disabled, pending, running])

  useEffect(() => {
    const focusWhenAvailable = () => {
      if (!composerCanFocus({ disabled, pending, running })) return
      textareaRef.current?.focus()
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") focusWhenAvailable()
    }

    window.addEventListener("focus", focusWhenAvailable)
    document.addEventListener("visibilitychange", handleVisibilityChange)
    return () => {
      window.removeEventListener("focus", focusWhenAvailable)
      document.removeEventListener("visibilitychange", handleVisibilityChange)
    }
  }, [disabled, pending, running])

  // Grow the textarea to fit its content, up to a max height where it starts scrolling.
  // Keep overflow hidden until the content actually exceeds the cap so an empty input does not
  // render a scrollbar in browsers configured to always show scroll bars.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the text changes
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT_PX ? "auto" : "hidden"
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`
  }, [value, attachments.length, contextEntries.length])

  const submit = () => {
    if (!canSend) return
    onSend(value.trim(), readyAttachments, contextEntries)
    setValue("")
    setAttachments([])
    dismissedAmbientRef.current.clear()
    setContextEntries(ambientContext.map((context) => ({ context, origin: "ambient" })))
    setMention(null)
    if (fileInputRef.current) fileInputRef.current.value = ""
  }

  const insertNewline = () => {
    const el = textareaRef.current
    if (!el) {
      setValue((current) => `${current}\n`)
      return
    }
    const start = el.selectionStart
    const end = el.selectionEnd
    setValue((current) => `${current.slice(0, start)}\n${current.slice(end)}`)
    // Restore the caret just after the inserted newline once React has applied the new value.
    requestAnimationFrame(() => {
      el.selectionStart = start + 1
      el.selectionEnd = start + 1
    })
  }

  const startUpload = useCallback(
    (file: File) => {
      const id = attachmentId()
      const pendingAttachment: ComposerAttachment = {
        id,
        status: "uploading",
        fileName: file.name,
        mediaType: file.type || undefined,
        sizeBytes: file.size,
      }
      setAttachments((current) => [...current, pendingAttachment])

      uploadFile
        .mutateAsync({ file, fileName: file.name })
        .then((fileRef) => {
          setAttachments((current) =>
            current.map((attachment) =>
              attachment.id === id
                ? { id, status: "ready", fileRef: fileRef as AgentFileRef }
                : attachment
            )
          )
        })
        .catch((error: unknown) => {
          setAttachments((current) =>
            current.map((attachment) =>
              attachment.id === id
                ? {
                    id,
                    status: "error",
                    fileName: file.name,
                    mediaType: file.type || undefined,
                    sizeBytes: file.size,
                    error: uploadErrorMessage(error),
                  }
                : attachment
            )
          )
        })
    },
    [uploadFile]
  )

  const handleFilesSelected = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return
      for (const file of Array.from(files)) {
        startUpload(file)
      }
      if (fileInputRef.current) fileInputRef.current.value = ""
    },
    [startUpload]
  )

  useEffect(() => {
    const resetDragState = () => {
      dragDepthRef.current = 0
      setDraggingFiles(false)
    }

    const handleDragEnter = (event: DragEvent) => {
      if (!hasDraggedFiles(event)) return
      event.preventDefault()
      dragDepthRef.current += 1
      if (!canAttachFiles) {
        if (event.dataTransfer) event.dataTransfer.dropEffect = "none"
        return
      }
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"
      setDraggingFiles(true)
    }

    const handleDragOver = (event: DragEvent) => {
      if (!hasDraggedFiles(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = canAttachFiles ? "copy" : "none"
      if (canAttachFiles) setDraggingFiles(true)
    }

    const handleDragLeave = (event: DragEvent) => {
      if (!hasDraggedFiles(event)) return
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
      if (dragDepthRef.current === 0) setDraggingFiles(false)
    }

    const handleDrop = (event: DragEvent) => {
      if (!hasDraggedFiles(event)) return
      event.preventDefault()
      const files = event.dataTransfer?.files ?? null
      resetDragState()
      if (canAttachFiles) handleFilesSelected(files)
    }

    const target: Window | Element | null = compact
      ? (rootRef.current?.closest("[data-agent-panel]") ?? rootRef.current)
      : window
    if (!target) return
    target.addEventListener("dragenter", handleDragEnter as EventListener)
    target.addEventListener("dragover", handleDragOver as EventListener)
    target.addEventListener("dragleave", handleDragLeave as EventListener)
    target.addEventListener("drop", handleDrop as EventListener)
    target.addEventListener("dragend", resetDragState)
    return () => {
      target.removeEventListener("dragenter", handleDragEnter as EventListener)
      target.removeEventListener("dragover", handleDragOver as EventListener)
      target.removeEventListener("dragleave", handleDragLeave as EventListener)
      target.removeEventListener("drop", handleDrop as EventListener)
      target.removeEventListener("dragend", resetDragState)
    }
  }, [canAttachFiles, compact, handleFilesSelected])

  const removeAttachment = (id: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id))
  }

  const removeContext = (index: number) => {
    setContextEntries((current) => {
      const entry = current[index]
      if (entry?.origin === "ambient") {
        dismissedAmbientRef.current.add(agentContextIdentity(entry.context))
      }
      return current.filter((_, candidateIndex) => candidateIndex !== index)
    })
  }

  const updateMention = (nextValue: string, caret: number | null) => {
    const candidate = findAgentContextMention(nextValue, caret ?? nextValue.length)
    setActiveContextResult(0)
    setMention(candidate && mentionKey(candidate) !== dismissedMention ? candidate : null)
  }

  const dismissMention = () => {
    if (mention) setDismissedMention(mentionKey(mention))
    setMention(null)
  }

  useEffect(() => {
    if (!mention) return
    const dismissedKey = mentionKey(mention)
    const handlePointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return
      setDismissedMention(dismissedKey)
      setMention(null)
    }
    document.addEventListener("pointerdown", handlePointerDown)
    return () => document.removeEventListener("pointerdown", handlePointerDown)
  }, [mention])

  const selectContextResult = (context: AgentContextInput) => {
    if (!mention) return
    const identity = agentContextIdentity(context)
    setContextEntries((current) => {
      const withoutDuplicate = current.filter(
        (entry) => agentContextIdentity(entry.context) !== identity
      )
      if (withoutDuplicate.length >= MAX_AGENT_CONTEXT_ENTRIES) return current
      return [...withoutDuplicate, { context, origin: "explicit" }]
    })
    dismissedAmbientRef.current.delete(identity)
    const next = removeAgentContextMention(value, mention)
    setValue(next.value)
    setMention(null)
    setDismissedMention(null)
    requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) return
      textarea.focus()
      textarea.selectionStart = next.caret
      textarea.selectionEnd = next.caret
    })
  }

  // Enter sends; Cmd/Ctrl+Enter and Shift+Enter insert a newline (and let the field grow).
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention) {
      if (event.key === "Escape") {
        event.preventDefault()
        dismissMention()
        return
      }
      if (contextResults.length > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault()
        const direction = event.key === "ArrowDown" ? 1 : -1
        setActiveContextResult(
          (current) => (current + direction + contextResults.length) % contextResults.length
        )
        return
      }
      if (
        contextResults.length > 0 &&
        (event.key === "Enter" || event.key === "Tab") &&
        !event.shiftKey &&
        !event.metaKey &&
        !event.ctrlKey
      ) {
        event.preventDefault()
        const result = contextResults[activeContextResult % contextResults.length]
        if (result) selectContextResult(result.context)
        return
      }
      if (
        event.key === "Tab" ||
        (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey)
      ) {
        // An open mention is incomplete UI syntax. Escape closes the picker when the user really
        // wants to keep literal @text in the message.
        event.preventDefault()
        return
      }
    }
    if (event.key !== "Enter") return
    if (event.shiftKey) return
    event.preventDefault()
    if (event.metaKey || event.ctrlKey) {
      insertNewline()
      return
    }
    submit()
  }

  const compactOverlayHost = compact
    ? rootRef.current?.closest<HTMLElement>("[data-agent-panel]")
    : null

  const statusHint = uploading
    ? "Uploading attachment…"
    : failedCount > 0
      ? `${failedCount} attachment ${failedCount === 1 ? "failed" : "failed"} to upload.`
      : hint

  return (
    <div ref={rootRef} className={cn("relative bg-background px-4 pt-2 pb-3", className)}>
      {draggingFiles ? (
        compactOverlayHost ? (
          createPortal(<DropFilesOverlay compact />, compactOverlayHost)
        ) : (
          <DropFilesOverlay compact={compact} />
        )
      ) : null}
      <div className="mx-auto w-full max-w-2xl">
        {error ? (
          <Marker role="alert" className="mb-2 items-start text-destructive">
            <MarkerIcon>
              <AlertTriangle className="text-destructive" />
            </MarkerIcon>
            <MarkerContent>{error}</MarkerContent>
          </Marker>
        ) : null}
        <div
          className={cn(
            "relative rounded-3xl border border-border bg-card shadow-sm transition-[border-color,box-shadow] duration-500",
            draggingFiles && "border-primary/50 ring-2 ring-primary/15"
          )}
        >
          <ContextPicker
            open={mention !== null}
            query={mentionQuery}
            loading={contextSearch.isFetching}
            results={contextResults}
            activeIndex={activeContextResult}
            onActiveIndexChange={setActiveContextResult}
            onSelect={selectContextResult}
          />
          <ContextChips
            entries={contextEntries}
            onRemove={removeContext}
            className="px-4 pt-3 pb-1"
          />
          {attachments.length > 0 ? (
            <div className="flex flex-wrap gap-2 px-4 pt-3 pb-1">
              {attachments.map((attachment) => (
                <AttachmentPreview
                  key={attachment.id}
                  attachment={attachment}
                  onRemove={() => removeAttachment(attachment.id)}
                />
              ))}
            </div>
          ) : null}
          <div className="px-4 pt-2.5 pb-1">
            <Textarea
              ref={textareaRef}
              autoFocus={composerCanFocus({ disabled, pending, running })}
              value={value}
              onChange={(event) => {
                setValue(event.target.value)
                setDismissedMention(null)
                updateMention(event.target.value, event.target.selectionStart)
              }}
              onSelect={(event) =>
                updateMention(event.currentTarget.value, event.currentTarget.selectionStart)
              }
              onKeyDown={handleKeyDown}
              disabled={disabled}
              rows={1}
              placeholder={placeholder ?? "Send a message…"}
              aria-label="Message"
              className="max-h-[200px] min-h-9 w-full resize-none overflow-y-hidden border-0 bg-transparent px-0 py-1 text-[15px] leading-relaxed shadow-none focus-visible:ring-0 md:text-[15px]"
            />
          </div>
          <div className="relative flex min-w-0 items-center gap-1 px-2.5 pb-2">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="sr-only"
              onChange={(event) => handleFilesSelected(event.target.files)}
              disabled={!canAttachFiles}
              aria-hidden="true"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={!canAttachFiles}
              aria-label="Attach files"
              className={cn(
                "flex size-9 shrink-0 items-center justify-center rounded-full text-foreground transition-colors",
                "hover:bg-muted disabled:cursor-not-allowed disabled:text-muted-foreground"
              )}
            >
              <Plus className="size-5" />
            </button>
            {onSelectModel && onSelectReasoning ? (
              <ModelControls
                models={models}
                selectedModel={selectedModel}
                selectedReasoning={selectedReasoning}
                loading={modelsLoading}
                error={modelsError}
                disabled={disabled || pending || running}
                onSelectModel={onSelectModel}
                onSelectReasoning={onSelectReasoning}
              />
            ) : null}
            <span className="min-w-0 flex-1" />
            {running ? (
              <button
                type="button"
                onClick={onStop}
                disabled={stopping}
                aria-label="Stop generating"
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-full transition-colors",
                  "bg-primary text-primary-foreground hover:bg-primary/90",
                  "disabled:bg-muted disabled:text-muted-foreground"
                )}
              >
                {stopping ? (
                  <Spinner className="size-4" />
                ) : (
                  <Square className="size-3.5 fill-current" />
                )}
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={!canSend}
                aria-label="Send message"
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-full transition-colors",
                  "bg-primary text-primary-foreground hover:bg-primary/90",
                  "disabled:bg-muted disabled:text-muted-foreground"
                )}
              >
                {pending || uploading ? (
                  <Spinner className="size-4" />
                ) : (
                  <ArrowUp className="size-[18px]" />
                )}
              </button>
            )}
          </div>
        </div>
        {statusHint ? (
          <p
            className={cn(
              "mt-1.5 px-1 text-[11px] text-muted-foreground",
              failedCount > 0 && "text-destructive"
            )}
          >
            {statusHint}
          </p>
        ) : null}
      </div>
    </div>
  )
}

function DropFilesOverlay({ compact }: { readonly compact: boolean }) {
  return (
    <div
      className={cn(
        "pointer-events-none inset-0 z-50 flex items-center justify-center bg-background/70 px-6 backdrop-blur-[2px]",
        compact ? "absolute" : "fixed"
      )}
    >
      <div className="flex max-w-sm flex-col items-center rounded-3xl border border-border/80 bg-card/95 px-8 py-7 text-center shadow-2xl shadow-black/10">
        <div className="relative mb-4 flex size-20 items-center justify-center">
          <div className="absolute -left-2 top-3 flex size-11 rotate-[-10deg] items-center justify-center rounded-2xl bg-blue-500 text-white shadow-lg shadow-blue-500/20">
            <ImageIcon className="size-5" />
          </div>
          <div className="absolute -right-2 top-2 flex size-11 rotate-[10deg] items-center justify-center rounded-2xl bg-emerald-500 text-white shadow-lg shadow-emerald-500/20">
            <FileText className="size-5" />
          </div>
          <div className="relative flex size-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-lg shadow-primary/25">
            <UploadCloud className="size-7" />
          </div>
        </div>
        <p className="text-xl font-semibold text-foreground">Add files</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Drop any file here to attach it to the conversation.
        </p>
      </div>
    </div>
  )
}

function AttachmentPreview({
  attachment,
  onRemove,
}: {
  attachment: ComposerAttachment
  onRemove: () => void
}) {
  const fileName = attachment.status === "ready" ? attachment.fileRef.fileName : attachment.fileName
  const mediaType =
    attachment.status === "ready" ? attachment.fileRef.mediaType : attachment.mediaType
  const { Icon, label, tone } = fileKind(fileName, mediaType)
  const subtitle =
    attachment.status === "uploading"
      ? "Uploading…"
      : attachment.status === "error"
        ? "Upload failed"
        : label

  return (
    <div
      className={cn(
        "relative flex max-w-full items-center gap-3 rounded-2xl border border-border bg-background py-2 pr-10 pl-2 shadow-sm",
        attachment.status === "error" && "border-destructive/40"
      )}
      title={attachment.status === "error" ? attachment.error : fileName}
    >
      <div
        className={cn(
          "flex size-10 shrink-0 items-center justify-center rounded-xl text-white",
          tone === "green" && "bg-emerald-500",
          tone === "red" && "bg-red-500",
          tone === "blue" && "bg-blue-500",
          tone === "zinc" && "bg-zinc-500"
        )}
      >
        {attachment.status === "uploading" ? (
          <Spinner className="size-5" />
        ) : (
          <Icon className="size-5" />
        )}
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-foreground">{fileName || "File"}</p>
        <p
          className={cn(
            "truncate text-xs text-muted-foreground",
            attachment.status === "error" && "text-destructive"
          )}
        >
          {subtitle}
        </p>
      </div>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${fileName || "attachment"}`}
        className="absolute top-2 right-2 flex size-5 items-center justify-center rounded-full bg-foreground text-background transition-opacity hover:opacity-80"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}

function fileKind(fileName: string | undefined, mediaType: string | undefined) {
  const normalizedName = fileName?.toLowerCase() ?? ""
  const normalizedType = mediaType?.toLowerCase() ?? ""
  if (
    normalizedType.includes("spreadsheet") ||
    normalizedType.includes("csv") ||
    /\.(csv|tsv|xls|xlsx)$/i.test(normalizedName)
  ) {
    return { Icon: Table2, label: "Spreadsheet", tone: "green" as const }
  }
  if (
    normalizedType.startsWith("image/") ||
    /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(normalizedName)
  ) {
    return { Icon: ImageIcon, label: "Image", tone: "blue" as const }
  }
  if (normalizedType === "application/pdf" || normalizedName.endsWith(".pdf")) {
    return { Icon: FileText, label: "PDF", tone: "red" as const }
  }
  if (normalizedType.startsWith("text/") || /\.(txt|md|json|yaml|yml)$/i.test(normalizedName)) {
    return { Icon: FileText, label: "Document", tone: "zinc" as const }
  }
  return { Icon: FileIcon, label: "File", tone: "zinc" as const }
}

function attachmentId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `attachment-${Date.now()}-${Math.random()}`
}

function mentionKey(candidate: AgentContextMention): string {
  return `${candidate.start}:${candidate.end}:${candidate.query}`
}

function hasDraggedFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files")
}

function uploadErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return "Could not upload attachment."
}
