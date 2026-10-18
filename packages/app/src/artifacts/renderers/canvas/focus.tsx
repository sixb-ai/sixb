import type { CanvasBoard } from "@sixb/core/artifacts"
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react"
import { type ReactNode, useEffect } from "react"
import { ArtifactFrame } from "../../frame"
import { useArtifactMessages } from "../../messages"
import type { ArtifactVersion } from "../../queries"

/**
 * A board opened over the canvas: its page at its own width, or the viewer's when that is
 * narrower, as tall as the viewer, scrolling and answering like a page. ← and → step through the
 * boards in the canvas's order, and Esc goes back to the canvas.
 */
export function BoardFocus({
  version,
  boards,
  id,
  onOpen,
  onClose,
}: {
  readonly version: ArtifactVersion
  readonly boards: readonly CanvasBoard[]
  readonly id: string
  readonly onOpen: (id: string) => void
  readonly onClose: () => void
}) {
  const messages = useArtifactMessages().canvas
  const index = boards.findIndex((board) => board.id === id)
  const board = boards[index]
  const previous = boards[index - 1]
  const next = boards[index + 1]

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      // Keys typed into a field are the field's.
      const target = event.target
      if (
        target instanceof Element &&
        target.closest("input, textarea, select, [contenteditable]")
      ) {
        return
      }
      if (event.key === "Escape") onClose()
      else if (event.key === "ArrowLeft" && previous) onOpen(previous.id)
      else if (event.key === "ArrowRight" && next) onOpen(next.id)
      else return
      event.preventDefault()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [previous, next, onOpen, onClose])

  if (!board) return null
  const title = board.title ?? board.id
  return (
    <div
      role="dialog"
      aria-label={messages.focused(title)}
      className="absolute inset-0 z-10 flex flex-col bg-background motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/70 px-2">
        <button
          type="button"
          onClick={onClose}
          className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          {messages.back}
        </button>
        <span className="h-5 w-px bg-border" aria-hidden="true" />
        <span className="min-w-0 truncate px-1 text-sm font-semibold">{title}</span>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {messages.position(index + 1, boards.length)}
        </span>
        <Step
          label={messages.previousBoard}
          disabled={!previous}
          onClick={() => previous && onOpen(previous.id)}
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
        </Step>
        <Step label={messages.nextBoard} disabled={!next} onClick={() => next && onOpen(next.id)}>
          <ChevronRight className="size-4" aria-hidden="true" />
        </Step>
      </div>
      <div className="flex min-h-0 flex-1 justify-center overflow-hidden bg-muted/40 p-3 sm:p-6">
        <div
          key={board.id}
          className="h-full w-full motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-97 motion-safe:duration-300 motion-safe:ease-out"
          style={{ maxWidth: board.w }}
        >
          <ArtifactFrame
            key={board.id}
            version={version}
            entry={board.file}
            title={messages.boardFrame(title)}
            className="sixb-canvas-surface size-full overflow-hidden"
          />
        </div>
      </div>
    </div>
  )
}

function Step({
  label,
  disabled,
  onClick,
  children,
}: {
  readonly label: string
  readonly disabled: boolean
  readonly onClick: () => void
  readonly children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-8 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-35"
    >
      {children}
    </button>
  )
}
