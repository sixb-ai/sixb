import { Spinner, Textarea } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { ArrowUp, Square } from "lucide-react"
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react"

export interface ComposerProps {
  readonly onSend: (text: string) => void
  readonly disabled?: boolean
  readonly pending?: boolean
  /** A run is in flight: the send button becomes a stop button that calls {@link onStop}. */
  readonly running?: boolean
  /** A stop has been requested and we're waiting for the run to end. */
  readonly stopping?: boolean
  readonly onStop?: () => void
  readonly placeholder?: string
  /** Optional status line shown under the input, e.g. while a run is active. */
  readonly hint?: string
  /**
   * Text to restore into the input, e.g. after a failed send so the user does not lose it.
   * Applied whenever `draftNonce` changes to a non-zero value, so re-sending the same text works.
   */
  readonly draft?: string
  readonly draftNonce?: number
}

const MAX_HEIGHT_PX = 200

export function Composer({
  onSend,
  disabled,
  pending,
  running,
  stopping,
  onStop,
  placeholder,
  hint,
  draft,
  draftNonce,
}: ComposerProps) {
  const [value, setValue] = useState("")
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const canSend = value.trim().length > 0 && !disabled && !pending

  // Reseed the input on demand (a failed send hands the text back). Keyed on the nonce so restoring
  // the same text twice still fires; ignored on mount (nonce 0) so it never clobbers a fresh draft.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reseed only when the nonce changes
  useEffect(() => {
    if (!draftNonce) return
    setValue(draft ?? "")
    textareaRef.current?.focus()
  }, [draftNonce])

  // Grow the textarea to fit its content, up to a max height where it starts scrolling.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the text changes
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`
  }, [value])

  const submit = () => {
    if (!canSend) return
    onSend(value.trim())
    setValue("")
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

  // Enter sends; Cmd/Ctrl+Enter and Shift+Enter insert a newline (and let the field grow).
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter") return
    if (event.shiftKey) return
    event.preventDefault()
    if (event.metaKey || event.ctrlKey) {
      insertNewline()
      return
    }
    submit()
  }

  return (
    <div className="bg-background px-4 pt-2 pb-3">
      <div className="mx-auto w-full max-w-3xl">
        <div className="flex items-end gap-2 rounded-3xl border border-border bg-card py-2 pr-2.5 pl-5 shadow-sm">
          <Textarea
            ref={textareaRef}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            rows={1}
            placeholder={placeholder ?? "Send a message…"}
            aria-label="Message"
            className="max-h-[200px] min-h-9 flex-1 resize-none overflow-y-auto border-0 bg-transparent px-0 py-1.5 text-[15px] leading-relaxed shadow-none focus-visible:ring-0 md:text-[15px]"
          />
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
              {pending ? <Spinner className="size-4" /> : <ArrowUp className="size-[18px]" />}
            </button>
          )}
        </div>
        {hint ? <p className="mt-1.5 px-1 text-[11px] text-muted-foreground">{hint}</p> : null}
      </div>
    </div>
  )
}
