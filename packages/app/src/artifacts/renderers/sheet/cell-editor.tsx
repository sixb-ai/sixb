import { Popover, PopoverAnchor, PopoverContent } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { type KeyboardEvent, useId, useLayoutEffect, useRef } from "react"

/** Where the selection goes when an edit is committed: Enter and Tab, with or without Shift. */
export type CommitMove = "down" | "up" | "right" | "left"

/**
 * A cell as it is typed into, over the cell itself: Enter and Tab commit and move on, with Shift
 * back; Esc puts the value back; leaving it commits. What doesn't fit the column's type is held
 * in place with why, and nothing is stored.
 */
export function CellEditor({
  text,
  error,
  numeric,
  label,
  suggestions,
  onChange,
  onCommit,
  onCancel,
}: {
  readonly text: string
  /** Why what was typed can't be the cell's value, after a commit was tried. */
  readonly error?: string
  readonly numeric: boolean
  readonly label: string
  /** Values to offer while typing, such as a tag column's tags. */
  readonly suggestions?: readonly string[]
  readonly onChange: (text: string) => void
  /** Stores what was typed: true when it was, false when it was held for not fitting. */
  readonly onCommit: (move: CommitMove | null) => boolean
  readonly onCancel: () => void
}) {
  const listId = useId()
  const errorId = useId()
  // Set once the edit ends by a key, so the blur that follows doesn't commit it again.
  const settled = useRef(false)
  const input = useRef<HTMLInputElement | null>(null)
  // The editor opens with focus, the caret after the value, as a spreadsheet's does.
  useLayoutEffect(() => {
    const element = input.current
    if (!element) return
    element.focus({ preventScroll: true })
    element.setSelectionRange(element.value.length, element.value.length)
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation()
    if (event.key === "Escape") {
      event.preventDefault()
      settled.current = true
      onCancel()
      return
    }
    const move: CommitMove | null =
      event.key === "Enter"
        ? event.shiftKey
          ? "up"
          : "down"
        : event.key === "Tab"
          ? event.shiftKey
            ? "left"
            : "right"
          : null
    if (!move || event.nativeEvent.isComposing) return
    event.preventDefault()
    settled.current = onCommit(move)
  }

  return (
    <Popover open={!!error}>
      <PopoverAnchor asChild>
        <input
          ref={input}
          value={text}
          aria-label={label}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          list={suggestions && suggestions.length > 0 ? listId : undefined}
          spellCheck={!numeric}
          autoComplete="off"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => {
            if (settled.current) return
            settled.current = true
            // Leaving with what doesn't fit puts the value back rather than hold the reader.
            if (!onCommit(null)) onCancel()
          }}
          className={cn(
            "absolute inset-0 z-[5] h-full w-full min-w-0 bg-(--sheet-cell) px-2 text-[13px] text-foreground outline-none",
            "shadow-[inset_0_0_0_2px_var(--primary),0_4px_14px_-6px_rgb(0_0_0/0.35)]",
            numeric && "text-right tabular-nums",
            error && "shadow-[inset_0_0_0_2px_var(--destructive),0_4px_14px_-6px_rgb(0_0_0/0.35)]"
          )}
        />
      </PopoverAnchor>
      {error ? (
        // Read out with the input, wherever the popover that shows it draws.
        <span id={errorId} role="alert" className="sr-only">
          {error}
        </span>
      ) : null}
      {suggestions && suggestions.length > 0 ? (
        <datalist id={listId}>
          {suggestions.map((value) => (
            <option key={value} value={value} />
          ))}
        </datalist>
      ) : null}
      <PopoverContent
        aria-hidden="true"
        side="bottom"
        align="start"
        sideOffset={4}
        // The input keeps focus: the message is read, not visited.
        onOpenAutoFocus={(event) => event.preventDefault()}
        className="w-auto max-w-72 border-[color-mix(in_oklab,var(--destructive)_35%,var(--border))] px-2.5 py-1.5 text-xs text-foreground"
      >
        {error}
      </PopoverContent>
    </Popover>
  )
}
