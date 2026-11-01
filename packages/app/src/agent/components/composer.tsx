import { searchObjectsOptions, useUploadFile } from "@sixb/client/hooks"
import {
  type AgentContextEntryInput,
  type AgentContextInput,
  agentContextFingerprint,
  agentContextIdentity,
  MAX_AGENT_CONTEXT_ENTRIES,
  MAX_AGENT_CONTEXT_LABEL_LENGTH,
} from "@sixb/core/agents/context"
import type { ModelReasoningLevel } from "@sixb/core/models"
import {
  DictationButton,
  Marker,
  MarkerContent,
  MarkerIcon,
  Spinner,
  Textarea,
} from "@sixb/ui/components"
import { useDictation } from "@sixb/ui/hooks"
import type { SpeechRecognizer } from "@sixb/ui/lib/speech"
import { cn } from "@sixb/ui/lib/utils"
import { useQuery } from "@tanstack/react-query"
import {
  AlertTriangle,
  ArrowUp,
  File as FileIcon,
  FileText,
  Image as ImageIcon,
  Square,
  Table2,
  UploadCloud,
  X,
} from "lucide-react"
import {
  type ClipboardEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { createPortal } from "react-dom"
import { type AgentApprovalMode, toggledApprovalMode } from "../approvals"
import { useAgentMessages } from "../i18n"
import type { AgentFileRef, LanguageModel } from "../types"
import { agentContextLabel, mergeAgentContext } from "../utils/context-display"
import {
  type AgentContextMention,
  findAgentContextMention,
  removeAgentContextMention,
} from "../utils/context-mention"
import { ComposerAddMenu } from "./composer-add-menu"
import {
  builtInCommands,
  type ComposerCommand,
  ComposerCommandList,
  commandQuery,
  matchCommands,
} from "./composer-commands"
import { ComposerSettings } from "./composer-settings"
import {
  COMPOSER_CHIP_CLASS_NAME,
  COMPOSER_CHIP_REMOVE_CLASS_NAME,
  COMPOSER_CHIP_THUMB_CLASS_NAME,
  ContextChips,
} from "./context-chips"
import { ContextMeter, type ContextMeterProps } from "./context-meter"
import { ContextPicker } from "./context-picker"
import { DictationBar } from "./dictation-bar"

export interface ComposerProps {
  readonly onSend: (
    text: string,
    attachments: readonly AgentFileRef[],
    context: readonly AgentContextEntryInput[]
  ) => void
  readonly disabled?: boolean
  readonly pending?: boolean
  /**
   * A run is in flight: the send button becomes a stop button that calls {@link onStop}, or stays
   * disabled without one, when the reader may not stop someone else's answer. The reader writes
   * the next message meanwhile, and sends it once the run ends.
   */
  readonly running?: boolean
  /** A stop has been requested and we're waiting for the run to end. */
  readonly stopping?: boolean
  readonly onStop?: () => void
  readonly models?: readonly LanguageModel[]
  readonly selectedModel?: LanguageModel
  readonly selectedReasoning?: ModelReasoningLevel
  readonly modelsLoading?: boolean
  readonly modelsError?: boolean
  readonly onSelectModel?: (model: LanguageModel) => void
  readonly onSelectReasoning?: (reasoning: ModelReasoningLevel) => void
  readonly onResetReasoning?: () => void
  /** The model selection follows the project defaults. */
  readonly usingDefaultModel?: boolean
  /** Follow the project defaults again. With tiers, back to Auto, which `selectedModel` unset shows. */
  readonly onResetModelSelection?: () => void
  /** With tiers: a decision model picks each message's model on Auto. */
  readonly modelRouting?: boolean
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
  /**
   * What the agent may change without asking in the reader's next turns. With
   * {@link onApprovalModeChange}, the composer shows it as a chip, and Shift+Tab in an empty input
   * cycles through the modes.
   */
  readonly approvalMode?: AgentApprovalMode
  readonly onApprovalModeChange?: (mode: AgentApprovalMode) => void
  /** A turn waits for the reader's approval: the input says how to answer it or move on. */
  readonly awaitingApproval?: boolean
  /**
   * Dictate the message: a microphone records it, and the transcript lands at the end of the
   * input. Omit for no microphone.
   */
  readonly dictation?: SpeechRecognizer
  /**
   * Slash commands of your own, listed after the built-in ones (`/auto`, one per model, `/ask`,
   * `/edits`, `/full`). A command is typed as the whole message and runs with Enter.
   */
  readonly commands?: readonly ComposerCommand[]
  /** How much of its model's limit the conversation uses: a ring beside the model. */
  readonly contextMeter?: ContextMeterProps
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
    }

const MAX_HEIGHT_PX = 200

// The microphone and Cancel: round, quiet until hovered.
const ICON_BUTTON_CLASS_NAME = cn(
  "flex size-10 shrink-0 items-center justify-center rounded-full text-foreground/80 outline-none transition-colors",
  "hover:bg-black/[0.05] focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50 dark:hover:bg-white/[0.08]"
)

// Send, stop and Done: the one filled control in the box.
const SEND_BUTTON_CLASS_NAME = cn(
  "sixb-composer-send flex size-10 shrink-0 items-center justify-center rounded-full outline-none transition-colors",
  "bg-foreground text-background hover:bg-foreground/85 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-card",
  "disabled:bg-foreground/25 disabled:text-background dark:disabled:bg-white/20 dark:disabled:text-white/70"
)

export function composerCanFocus({
  disabled,
  pending,
}: Pick<ComposerProps, "disabled" | "pending">): boolean {
  return !disabled && !pending
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
  onResetReasoning,
  usingDefaultModel,
  onResetModelSelection,
  modelRouting,
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
  approvalMode,
  onApprovalModeChange,
  awaitingApproval = false,
  dictation,
  commands = [],
  contextMeter,
}: ComposerProps) {
  const agentMessages = useAgentMessages()
  const messages = agentMessages.composer
  const unnamedContext = agentMessages.context.unnamed
  const [value, setValue] = useState("")
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [contextEntries, setContextEntries] = useState<AgentContextEntryInput[]>(() =>
    ambientContext.map((context) => ({ context, origin: "ambient" }))
  )
  const [mention, setMention] = useState<AgentContextMention | null>(null)
  const [dismissedMention, setDismissedMention] = useState<string | null>(null)
  const [activeContextResult, setActiveContextResult] = useState(0)
  const [activeCommand, setActiveCommand] = useState(0)
  // A command list the reader closed with Escape stays closed for that text.
  const [dismissedCommand, setDismissedCommand] = useState<string | null>(null)
  // The text no longer fits beside the controls: it gets a row of its own.
  const [wraps, setWraps] = useState(false)
  const [draggingFiles, setDraggingFiles] = useState(false)
  // Said once the mode changes from the keyboard, where the chip itself may be out of sight.
  const [modeAnnouncement, setModeAnnouncement] = useState("")
  const rootRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const sizerRef = useRef<HTMLSpanElement>(null)
  // The text's width in a single row, measured while it has one.
  const inlineWidthRef = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragDepthRef = useRef(0)
  const uploadFile = useUploadFile()
  // The transcript is appended to the text as it was when dictation started, so the input stays
  // read-only until it lands. Recording ends only when the reader stops it: no restarts. A
  // composer disabled meanwhile, by someone else's turn, only keeps a new dictation from starting.
  const voice = useDictation({
    value,
    onChange: setValue,
    recognizer: dictation,
    disabled: !dictation,
    autoRestart: false,
  })
  const wasDictatingRef = useRef(false)
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
      agentContextLabel(context, unnamedContext).toLowerCase().includes(normalizedQuery)
    )
    // A picked result keeps the label it was listed with, so its chip and its history entry show
    // what the user chose.
    const remote = (contextSearch.data?.items ?? []).map(
      (item) =>
        ({
          kind: "object",
          ref: item.ref,
          ...contextLabel(item.label),
        }) as const satisfies AgentContextInput
    )
    return mergeAgentContext(local, remote).map((context) => ({
      context,
      label: agentContextLabel(context, unnamedContext),
    }))
  }, [ambientContext, contextSearch.data?.items, mention, unnamedContext])

  const uploading = attachments.some((attachment) => attachment.status === "uploading")
  const readyAttachments = attachments.flatMap((attachment) =>
    attachment.status === "ready" ? [attachment.fileRef] : []
  )
  const failedCount = attachments.filter((attachment) => attachment.status === "error").length
  const canAttachFiles = !disabled && !pending
  const showPermissions = approvalMode !== undefined && onApprovalModeChange !== undefined
  const commandText = commandQuery(value)
  const commandMatches =
    commandText === null || dismissedCommand === value || voice.isActive
      ? []
      : matchCommands(allCommands(), commandText).slice(0, 6)
  const commandsOpen = commandMatches.length > 0
  // Files alone are a message too.
  const canSend =
    (value.trim().length > 0 || readyAttachments.length > 0) &&
    mention === null &&
    !commandsOpen &&
    !disabled &&
    !pending &&
    !running &&
    !uploading &&
    !voice.isActive &&
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

  // However a dictation ends, the focus returns to the input, the caret after any transcript.
  useEffect(() => {
    const wasDictating = wasDictatingRef.current
    wasDictatingRef.current = voice.isActive
    const input = textareaRef.current
    if (!wasDictating || voice.isActive || !input) return

    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
  }, [voice.isActive])

  useEffect(() => {
    const focusWhenAvailable = () => {
      if (!composerCanFocus({ disabled, pending })) return
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
  }, [disabled, pending])

  // A draft that no longer fits in one row beside the controls takes a row of its own, with the
  // controls under it. The row's width is measured while the draft still has it, so the box only
  // folds back once the text fits there again.
  const expanded =
    wraps ||
    value.includes("\n") ||
    attachments.length > 0 ||
    contextEntries.length > 0 ||
    (voice.isActive && value.trim().length > 0)
  // Grow the textarea to fit its content, up to a max height where it starts scrolling.
  // Keep overflow hidden until the content actually exceeds the cap so an empty input does not
  // render a scrollbar in browsers configured to always show scroll bars.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the text changes
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    if (!expanded) inlineWidthRef.current = el.clientWidth
    const sizer = sizerRef.current
    setWraps(
      sizer !== null && inlineWidthRef.current > 0 && sizer.offsetWidth > inlineWidthRef.current
    )
    el.style.height = "auto"
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT_PX ? "auto" : "hidden"
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`
  }, [value, attachments.length, contextEntries.length, expanded])

  const submit = () => {
    if (!canSend) return
    onSend(value.trim(), readyAttachments, contextEntries)
    setValue("")
    voice.reset()
    setAttachments([])
    dismissedAmbientRef.current.clear()
    setContextEntries(ambientContext.map((context) => ({ context, origin: "ambient" })))
    setMention(null)
    if (fileInputRef.current) fileInputRef.current.value = ""
    // Stop replaces the send button a click left the focus on: the next message starts here.
    textareaRef.current?.focus()
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
        // The API explains failures to developers; the composer shows its own message.
        .catch(() => {
          setAttachments((current) =>
            current.map((attachment) =>
              attachment.id === id
                ? {
                    id,
                    status: "error",
                    fileName: file.name,
                    mediaType: file.type || undefined,
                    sizeBytes: file.size,
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

  // A pasted screenshot or copied image uploads as a dropped file does. Text wins: Excel or Word
  // copy a picture of the selection beside its text, and whoever pastes cells wants the text.
  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = clipboardFiles(event.clipboardData)
    if (files.length === 0 || event.clipboardData.getData("text/plain").trim()) return

    event.preventDefault()
    if (!canAttachFiles) return
    for (const file of files) {
      startUpload(file)
    }
  }

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

  const changeApprovalMode = (mode: AgentApprovalMode) => {
    onApprovalModeChange?.(mode)
    setModeAnnouncement(
      agentMessages.approvalModes.changed(agentMessages.approvalModes.modes[mode].label)
    )
  }

  function allCommands(): readonly ComposerCommand[] {
    const choosesModel = onSelectModel !== undefined && onSelectReasoning !== undefined
    return [
      ...builtInCommands({
        models,
        onSelectModel: choosesModel ? onSelectModel : undefined,
        onResetModelSelection: choosesModel ? onResetModelSelection : undefined,
        // Called on Enter, long after the render that lists it.
        onApprovalModeChange: showPermissions ? (mode) => changeApprovalMode(mode) : undefined,
        messages: agentMessages.commands,
      }),
      ...commands,
    ]
  }

  const runCommand = (command: ComposerCommand) => {
    command.run()
    setValue("")
    setActiveCommand(0)
    setDismissedCommand(null)
    textareaRef.current?.focus()
  }

  // Types at the caret, as the `+` menu's mention and command do, and keeps the focus there.
  const insertAtCaret = (text: string) => {
    const el = textareaRef.current
    const start = el?.selectionStart ?? value.length
    const end = el?.selectionEnd ?? value.length
    const spaced = start > 0 && !/\s/.test(value[start - 1] ?? "") ? ` ${text}` : text
    const next = `${value.slice(0, start)}${spaced}${value.slice(end)}`
    const caret = start + spaced.length
    setValue(next)
    setDismissedMention(null)
    updateMention(next, caret)
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(caret, caret)
    })
  }

  // Enter sends; Cmd/Ctrl+Enter and Shift+Enter insert a newline (and let the field grow).
  // Shift+Tab in an empty input cycles Ask first, Allow edits and Full access, as in a terminal
  // agent; once something is typed, it moves focus back as everywhere else. A slash command being
  // typed runs on Enter instead of being sent.
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // While dictating, Enter finishes and Escape cancels from the input too, as from the bar.
    if (voice.isActive) {
      if (event.key === "Enter") voice.stop()
      else if (event.key === "Escape") voice.abort()
      else return
      event.preventDefault()
      return
    }
    if (
      event.key === "Tab" &&
      event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      value.length === 0 &&
      mention === null &&
      approvalMode !== undefined &&
      onApprovalModeChange
    ) {
      event.preventDefault()
      changeApprovalMode(toggledApprovalMode(approvalMode))
      return
    }
    if (commandsOpen) {
      if (event.key === "Escape") {
        event.preventDefault()
        setDismissedCommand(value)
        return
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault()
        const direction = event.key === "ArrowDown" ? 1 : -1
        setActiveCommand(
          (current) => (current + direction + commandMatches.length) % commandMatches.length
        )
        return
      }
      if (
        (event.key === "Enter" || event.key === "Tab") &&
        !event.shiftKey &&
        !event.metaKey &&
        !event.ctrlKey
      ) {
        event.preventDefault()
        const command = commandMatches[activeCommand % commandMatches.length]
        if (command) runCommand(command)
        return
      }
    }
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
    ? messages.uploadingAttachment
    : failedCount > 0
      ? messages.attachmentsFailed(failedCount)
      : (voice.error ?? hint)
  const statusIsError = !uploading && (failedCount > 0 || voice.error !== null)

  const hasDraft = value.trim().length > 0 || readyAttachments.length > 0
  // With a microphone, send appears once there is something to send; it waits there otherwise. A
  // command being typed is run, not sent.
  const showSend = (hasDraft && !commandsOpen) || pending || uploading || running || !dictation

  return (
    <div ref={rootRef} className={cn("relative bg-background px-4 pt-2 pb-3", className)}>
      {draggingFiles ? (
        compactOverlayHost ? (
          createPortal(<DropFilesOverlay compact />, compactOverlayHost)
        ) : (
          <DropFilesOverlay compact={compact} />
        )
      ) : null}
      <div className="mx-auto w-full max-w-[46rem]">
        {error ? (
          <Marker role="alert" className="mb-2 items-start text-destructive">
            <MarkerIcon>
              <AlertTriangle className="text-destructive" />
            </MarkerIcon>
            <MarkerContent>{error}</MarkerContent>
          </Marker>
        ) : null}
        <div className="relative">
          <ContextPicker
            open={mention !== null}
            query={mentionQuery}
            loading={contextSearch.isFetching}
            results={contextResults}
            activeIndex={activeContextResult}
            onActiveIndexChange={setActiveContextResult}
            onSelect={selectContextResult}
          />
          <ComposerCommandList
            open={commandsOpen}
            query={commandText ?? ""}
            commands={commandMatches}
            activeIndex={activeCommand % Math.max(commandMatches.length, 1)}
            onActiveIndexChange={setActiveCommand}
            onRun={runCommand}
          />
          {/*
            One row while the draft fits beside the controls; once it doesn't, the draft gets a row
            of its own and the controls sit under it. Attachments and context lead, on their own row.
          */}
          <div
            data-dragging={draggingFiles || undefined}
            data-expanded={expanded || undefined}
            className="group/composer sixb-composer-surface relative flex flex-wrap items-end gap-0.5 rounded-[30px] p-2.5 data-[expanded]:gap-y-1 data-[expanded]:rounded-[26px]"
          >
            {/* The draft on one line, to tell when it stops fitting there. */}
            <span
              aria-hidden="true"
              className="pointer-events-none invisible absolute inset-0 overflow-hidden"
            >
              <span
                ref={sizerRef}
                className="absolute whitespace-pre px-2 text-[16px] tracking-[-0.012em]"
              >
                {value}
              </span>
            </span>
            {contextEntries.length > 0 || attachments.length > 0 ? (
              <div className="order-first flex basis-full flex-wrap gap-1.5 px-0.5 pt-0.5 pb-1">
                <ContextChips
                  entries={contextEntries}
                  onRemove={removeContext}
                  className="contents"
                />
                {attachments.map((attachment) => (
                  <AttachmentChip
                    key={attachment.id}
                    attachment={attachment}
                    onRemove={() => removeAttachment(attachment.id)}
                  />
                ))}
              </div>
            ) : null}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="sr-only"
              onChange={(event) => handleFilesSelected(event.target.files)}
              disabled={!canAttachFiles}
              aria-hidden="true"
              tabIndex={-1}
            />
            {voice.isActive ? null : (
              <>
                <ComposerAddMenu
                  disabled={disabled}
                  onAddFiles={canAttachFiles ? () => fileInputRef.current?.click() : undefined}
                  onMention={() => insertAtCaret("@")}
                  onCommand={
                    value.length === 0 && allCommands().length > 0
                      ? () => insertAtCaret("/")
                      : undefined
                  }
                />
                <span
                  aria-hidden="true"
                  className="hidden flex-1 group-data-[expanded]/composer:block"
                />
              </>
            )}
            <Textarea
              ref={textareaRef}
              autoFocus={composerCanFocus({ disabled, pending })}
              value={value}
              onChange={(event) => {
                setValue(event.target.value)
                if (voice.error) voice.reset()
                setDismissedMention(null)
                setActiveCommand(0)
                updateMention(event.target.value, event.target.selectionStart)
              }}
              onSelect={(event) =>
                updateMention(event.currentTarget.value, event.currentTarget.selectionStart)
              }
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              disabled={disabled}
              readOnly={voice.isActive}
              rows={1}
              placeholder={
                voice.status === "stopping"
                  ? messages.dictationTranscribing
                  : voice.isActive
                    ? messages.dictationListening
                    : awaitingApproval
                      ? agentMessages.approvals.composerPlaceholder
                      : (placeholder ?? messages.placeholder)
              }
              aria-label={messages.message}
              className={cn(
                "max-h-[200px] min-h-10 min-w-0 flex-1 resize-none overflow-y-hidden rounded-none border-0 bg-transparent px-2 py-2 text-[16px] leading-6 tracking-[-0.012em] shadow-none placeholder:text-muted-foreground focus-visible:ring-0 md:text-[16px] dark:bg-transparent",
                "group-data-[expanded]/composer:order-[-1] group-data-[expanded]/composer:basis-full group-data-[expanded]/composer:px-2.5 group-data-[expanded]/composer:pt-1.5 group-data-[expanded]/composer:pb-1",
                // While dictating, the text being spoken into stays; an empty field makes way.
                voice.isActive && "read-only:text-muted-foreground",
                voice.isActive && value.trim().length === 0 && "hidden"
              )}
            />
            {voice.isActive ? (
              <DictationBar
                dictation={voice}
                buttonClassName={ICON_BUTTON_CLASS_NAME}
                doneClassName={SEND_BUTTON_CLASS_NAME}
              />
            ) : (
              <>
                {contextMeter ? <ContextMeter {...contextMeter} /> : null}
                <ComposerSettings
                  models={models}
                  selectedModel={selectedModel}
                  selectedReasoning={selectedReasoning}
                  modelsLoading={modelsLoading}
                  modelsError={modelsError}
                  onSelectModel={onSelectModel}
                  onSelectReasoning={onSelectReasoning}
                  onResetReasoning={onResetReasoning}
                  usingDefaultModel={usingDefaultModel}
                  onResetModelSelection={onResetModelSelection}
                  modelRouting={modelRouting}
                  approvalMode={showPermissions ? approvalMode : undefined}
                  onApprovalModeChange={showPermissions ? changeApprovalMode : undefined}
                  disabled={disabled || pending || running}
                />
                {dictation ? (
                  <DictationButton
                    dictation={voice}
                    disabled={disabled}
                    variant="ghost"
                    size="icon"
                    className={cn(
                      ICON_BUTTON_CLASS_NAME,
                      "bg-transparent shadow-none [&_svg]:size-5"
                    )}
                  />
                ) : null}
                {running && onStop ? (
                  <button
                    type="button"
                    onClick={onStop}
                    disabled={stopping}
                    aria-label={messages.stop}
                    className={SEND_BUTTON_CLASS_NAME}
                  >
                    {stopping ? (
                      <Spinner className="size-4" />
                    ) : (
                      <Square className="size-3 fill-current" />
                    )}
                  </button>
                ) : showSend ? (
                  <button
                    type="button"
                    onClick={submit}
                    disabled={!canSend}
                    aria-label={messages.send}
                    className={SEND_BUTTON_CLASS_NAME}
                  >
                    {pending || uploading ? (
                      <Spinner className="size-4" />
                    ) : (
                      <ArrowUp className="size-[18px]" strokeWidth={2.4} />
                    )}
                  </button>
                ) : null}
              </>
            )}
          </div>
        </div>
        <span className="sr-only" aria-live="polite">
          {modeAnnouncement}
        </span>
        {statusHint ? (
          <p
            className={cn(
              "mt-2 truncate px-4 text-xs text-muted-foreground",
              statusIsError && "text-destructive"
            )}
            title={statusHint}
          >
            {statusHint}
          </p>
        ) : null}
      </div>
    </div>
  )
}

function DropFilesOverlay({ compact }: { readonly compact: boolean }) {
  const messages = useAgentMessages().composer
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
        <p className="text-xl font-semibold text-foreground">{messages.addFiles}</p>
        <p className="mt-1 text-sm text-muted-foreground">{messages.dropFiles}</p>
      </div>
    </div>
  )
}

function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: ComposerAttachment
  onRemove: () => void
}) {
  const agentMessages = useAgentMessages()
  const messages = agentMessages.composer
  const fileName = attachment.status === "ready" ? attachment.fileRef.fileName : attachment.fileName
  const mediaType =
    attachment.status === "ready" ? attachment.fileRef.mediaType : attachment.mediaType
  const Icon = fileIcon(fileName, mediaType)
  const status =
    attachment.status === "uploading"
      ? messages.uploading
      : attachment.status === "error"
        ? messages.uploadFailed
        : null

  return (
    <span
      className={cn(COMPOSER_CHIP_CLASS_NAME, "pr-1.5")}
      title={attachment.status === "error" ? messages.uploadError : fileName}
    >
      <span className={COMPOSER_CHIP_THUMB_CLASS_NAME}>
        {attachment.status === "uploading" ? (
          <Spinner className="size-3" />
        ) : (
          <Icon className="size-3" strokeWidth={2} aria-hidden="true" />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate">{fileName || agentMessages.files.file}</span>
      {status ? (
        <span
          className={cn(
            "shrink-0 text-xs text-muted-foreground",
            attachment.status === "error" && "text-destructive"
          )}
        >
          {status}
        </span>
      ) : null}
      <button
        type="button"
        onClick={onRemove}
        aria-label={
          fileName ? messages.removeAttachment(fileName) : messages.removeUnnamedAttachment
        }
        className={COMPOSER_CHIP_REMOVE_CLASS_NAME}
      >
        <X className="size-[11px]" strokeWidth={2.6} />
      </button>
    </span>
  )
}

function fileIcon(fileName: string | undefined, mediaType: string | undefined) {
  const normalizedName = fileName?.toLowerCase() ?? ""
  const normalizedType = mediaType?.toLowerCase() ?? ""
  if (
    normalizedType.includes("spreadsheet") ||
    normalizedType.includes("csv") ||
    /\.(csv|tsv|xls|xlsx)$/i.test(normalizedName)
  ) {
    return Table2
  }
  if (
    normalizedType.startsWith("image/") ||
    /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(normalizedName)
  ) {
    return ImageIcon
  }
  if (
    normalizedType === "application/pdf" ||
    normalizedType.startsWith("text/") ||
    /\.(pdf|txt|md|json|yaml|yml)$/i.test(normalizedName)
  ) {
    return FileText
  }
  return FileIcon
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

/** The files a paste carries; a browser that lists none may still hold them as items. */
function clipboardFiles(data: DataTransfer): File[] {
  const files = Array.from(data.files)
  if (files.length > 0) return files

  return Array.from(data.items).flatMap((item) => {
    const file = item.kind === "file" ? item.getAsFile() : null
    return file ? [file] : []
  })
}

function contextLabel(label: string): { readonly label?: string } {
  const trimmed = label.trim()
  if (!trimmed) return {}
  return {
    label:
      trimmed.length > MAX_AGENT_CONTEXT_LABEL_LENGTH
        ? `${trimmed.slice(0, MAX_AGENT_CONTEXT_LABEL_LENGTH - 1).trimEnd()}…`
        : trimmed,
  }
}
