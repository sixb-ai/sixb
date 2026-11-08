import type { CanvasArrow, CanvasBoard } from "@sixb/core/artifacts"
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react"
import { type ReactNode, useCallback, useEffect, useState } from "react"
import type { LiveArtifact } from "../../live/session"
import { useArtifactMessages } from "../../messages"
import type { ArtifactVersion } from "../../queries"
import { type BoardEditor, BoardStage, type CommentPick, type StageMode } from "./board-editor"
import type { DraftPlace, PinPlace } from "./comment-pins"

/**
 * A board opened over the canvas: its page at the board's own size, as the canvas and its picture
 * show it, scaled to fit the viewer, and answering like a page. Its picture shows until the page
 * is ready, and stays, with a word, if the page never is. ← and → step through the boards in the
 * canvas's order, and Esc goes back to the canvas.
 *
 * It is a prototype too: pressing a button or a link within the page that reads as the label of an
 * arrow leaving the board opens the board the arrow points to.
 *
 * Opened from a canvas edited live, its elements are edited in place; placing a comment, a click
 * picks the element it is about. Its comments' pins show over it.
 */
export function BoardFocus({
  version,
  boards,
  arrows,
  id,
  pictureOf,
  onOpen,
  onClose,
  live = null,
  canvas = null,
  mode = "read",
  pins = [],
  activePin = null,
  draft = null,
  tools,
  onEscape,
  onPick,
  onOpenPin,
  onSubmitDraft,
  onCancelDraft,
}: {
  readonly version: ArtifactVersion
  readonly boards: readonly CanvasBoard[]
  readonly arrows: readonly CanvasArrow[]
  readonly id: string
  /** A board's picture at its own size, when it has one. */
  readonly pictureOf?: (id: string) => string | undefined
  readonly onOpen: (id: string) => void
  readonly onClose: () => void
  /** The canvas held live: the board shows what its document holds now. */
  readonly live?: LiveArtifact | null
  /** What edits the board's elements, while the reader edits the canvas. */
  readonly canvas?: BoardEditor | null
  readonly mode?: StageMode
  readonly pins?: readonly PinPlace[]
  readonly activePin?: string | null
  readonly draft?: DraftPlace | null
  /** The comment tools, in the header. */
  readonly tools?: ReactNode
  /** Esc, before it closes the board: true when it was taken, as a comment given up. */
  readonly onEscape?: () => boolean
  readonly onPick?: (board: string, pick: CommentPick) => void
  readonly onOpenPin?: (id: string) => void
  readonly onSubmitDraft?: (body: string) => Promise<void>
  readonly onCancelDraft?: () => void
}) {
  const messages = useArtifactMessages().canvas
  const index = boards.findIndex((board) => board.id === id)
  const board = boards[index]
  const previous = boards[index - 1]
  const next = boards[index + 1]
  const [stage, setStage] = useState<HTMLDivElement | null>(null)
  const room = useSize(stage)

  const onPress = useCallback(
    (text: string) => {
      const to = followedArrow(arrows, boards, id, text)
      if (to) onOpen(to)
    },
    [arrows, boards, id, onOpen]
  )
  const pick = useCallback((place: CommentPick) => onPick?.(id, place), [onPick, id])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      // Keys typed into a field are the field's.
      const target = event.target
      if (
        target instanceof Element &&
        target.closest("input, textarea, select, [contenteditable], [data-board-tools]")
      ) {
        return
      }
      if (event.key === "Escape") {
        if (!onEscape?.()) onClose()
      } else if (event.key === "ArrowLeft" && previous) onOpen(previous.id)
      else if (event.key === "ArrowRight" && next) onOpen(next.id)
      else return
      event.preventDefault()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [previous, next, onOpen, onClose, onEscape])

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
        {mode === "edit" ? (
          <span className="hidden min-w-0 truncate text-xs text-muted-foreground @5xl/canvas:inline">
            {messages.edit.hint}
          </span>
        ) : null}
        {tools ? <div className="ml-auto flex shrink-0 items-center">{tools}</div> : null}
        <span
          className={`${tools ? "" : "ml-auto "}shrink-0 text-xs whitespace-nowrap text-muted-foreground tabular-nums max-sm:hidden`}
        >
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
              className="sixb-canvas-surface relative shrink-0 motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-97 motion-safe:duration-300 motion-safe:ease-out"
              style={{ width: board.w * scale, height: board.h * scale }}
            >
              <BoardStage
                version={version}
                board={board}
                title={title}
                scale={scale}
                live={live}
                canvas={canvas}
                mode={mode}
                pins={pins.filter((pin) => pin.board === board.id)}
                activePin={activePin}
                draft={draft?.board === board.id ? draft : null}
                fallback={picture ? <BoardPicture src={picture} /> : undefined}
                failure={
                  <div className="relative size-full">
                    {picture ? <BoardPicture src={picture} /> : null}
                    <p className="absolute inset-x-0 bottom-0 m-0 bg-background/90 px-4 py-2 text-sm text-muted-foreground">
                      {messages.boardFailed}
                    </p>
                  </div>
                }
                onPress={onPress}
                onPick={pick}
                onOpenPin={(pin) => onOpenPin?.(pin)}
                onSubmitDraft={(body) => onSubmitDraft?.(body) ?? Promise.resolve()}
                onCancelDraft={() => onCancelDraft?.()}
              />
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
