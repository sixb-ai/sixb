import type { CanvasArrow, CanvasBoard, FrameEvent } from "@sixb/core/artifacts"
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react"
import { type ReactNode, useCallback, useEffect, useState } from "react"
import { ArtifactFrame } from "../../frame"
import { useArtifactMessages } from "../../messages"
import type { ArtifactVersion } from "../../queries"

/**
 * A board opened over the canvas: its page at the board's own size, as the canvas and its picture
 * show it, scaled to fit the viewer, and answering like a page. Its picture shows until the page
 * is ready, and stays, with a word, if the page never is. ← and → step through the boards in the
 * canvas's order, and Esc goes back to the canvas.
 *
 * It is a prototype too: pressing a button or a link within the page that reads as the label of an
 * arrow leaving the board opens the board the arrow points to.
 */
export function BoardFocus({
  version,
  boards,
  arrows,
  id,
  pictureOf,
  onOpen,
  onClose,
}: {
  readonly version: ArtifactVersion
  readonly boards: readonly CanvasBoard[]
  readonly arrows: readonly CanvasArrow[]
  readonly id: string
  /** A board's picture at its own size, when it has one. */
  readonly pictureOf?: (id: string) => string | undefined
  readonly onOpen: (id: string) => void
  readonly onClose: () => void
}) {
  const messages = useArtifactMessages().canvas
  const index = boards.findIndex((board) => board.id === id)
  const board = boards[index]
  const previous = boards[index - 1]
  const next = boards[index + 1]
  const [stage, setStage] = useState<HTMLDivElement | null>(null)
  const room = useSize(stage)

  const onEvent = useCallback(
    (event: FrameEvent) => {
      if (event.event !== "press") return

      const to = followedArrow(arrows, boards, id, event.params.text)
      if (to) onOpen(to)
    },
    [arrows, boards, id, onOpen]
  )

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
  const scale = room ? Math.min(MAX_SCALE, room.width / board.w, room.height / board.h) : 0
  const picture = pictureOf?.(board.id)
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
      <div className="flex min-h-0 flex-1 overflow-hidden bg-muted/40 p-3 sm:p-6">
        <div ref={setStage} className="flex min-h-0 min-w-0 flex-1 items-center justify-center">
          {scale > 0 ? (
            // The box the board takes on screen; the page inside is laid out at the board's size.
            <div
              key={board.id}
              className="sixb-canvas-surface relative shrink-0 overflow-hidden motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-97 motion-safe:duration-300 motion-safe:ease-out"
              style={{ width: board.w * scale, height: board.h * scale }}
            >
              <div
                className="absolute top-0 left-0 origin-top-left"
                style={{ width: board.w, height: board.h, transform: `scale(${scale})` }}
              >
                <ArtifactFrame
                  key={board.id}
                  version={version}
                  entry={board.file}
                  title={messages.boardFrame(title)}
                  className="size-full"
                  onEvent={onEvent}
                  fallback={picture ? <BoardPicture src={picture} /> : undefined}
                  failure={
                    <div className="relative size-full">
                      {picture ? <BoardPicture src={picture} /> : null}
                      <p className="absolute inset-x-0 bottom-0 m-0 bg-background/90 px-4 py-2 text-sm text-muted-foreground">
                        {messages.boardFailed}
                      </p>
                    </div>
                  }
                />
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/**
 * The board an arrow leaving `from` points to, when its label reads as `pressed`, case and spaces
 * aside: the first such arrow the canvas lists, to a board.
 */
export function followedArrow(
  arrows: readonly CanvasArrow[],
  boards: readonly CanvasBoard[],
  from: string,
  pressed: string
): string | null {
  const words = wordsOf(pressed)
  for (const arrow of arrows) {
    const to = arrow.to
    if (arrow.from !== from || typeof to !== "string" || !arrow.label) continue
    if (wordsOf(arrow.label) !== words) continue
    if (boards.some((board) => board.id === to)) return to
  }
  return null
}

function wordsOf(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase()
}

/** The most an opened board is enlarged to fit the viewer, as far as the canvas zooms. */
const MAX_SCALE = 2.5

/** A board's picture at its own size, drawn from its top as its tile draws it. */
function BoardPicture({ src }: { readonly src: string }) {
  return (
    <img
      src={src}
      alt=""
      decoding="async"
      draggable={false}
      className="absolute inset-0 block size-full object-contain object-top"
    />
  )
}

/** An element's size as it is laid out, followed as it changes; null until it is measured. */
function useSize(element: HTMLElement | null): { width: number; height: number } | null {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)

  useEffect(() => {
    if (!element) return

    const measure = () => {
      const width = element.clientWidth
      const height = element.clientHeight
      setSize((last) =>
        last && last.width === width && last.height === height ? last : { width, height }
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])

  return size
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
