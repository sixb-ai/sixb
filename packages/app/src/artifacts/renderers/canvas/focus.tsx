import type { CanvasArrow, CanvasBoard, FrameZoom, FrameZoomStep } from "@sixb/core/artifacts"
import { cn } from "@sixb/ui/lib/utils"
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react"
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react"
import type { LiveArtifact } from "../../live/session"
import { useArtifactMessages } from "../../messages"
import type { ArtifactVersion } from "../../queries"
import { type BoardEditor, BoardStage, type CommentPick, type StageMode } from "./board-editor"
import type { DraftPlace, PinPlace } from "./comment-pins"
import { ZoomBar } from "./controls"
import type { Box } from "./draft"
import { PageResizer } from "./page-resize"
import type { PageSize, SizeName, SnappedSize } from "./page-size"
import { SizeControls } from "./page-size-controls"
import { usePageZoom } from "./page-zoom"
import { useShownSize } from "./shown-size"

/** How long a size kept as the board's is said. */
const KEPT_MS = 2400

/**
 * A board opened over the canvas: its page at the board's own size, as the canvas and its picture
 * show it, and answering like a page. Its picture shows until the page is ready, and stays, with
 * a word, if the page never is. ← and → step through the boards in the canvas's order, and Esc
 * goes back to the canvas.
 *
 * It opens fitted: whole, or, taller than wide, to its width, scrolling down it as a document's
 * page. The zoom bar, a pinch or ⌘ with the wheel over it, ⌘ +, − and 0, and a double-click beside
 * it zoom it. Its edges resize it for the reader alone, laid out again at that size while it is
 * open, until they go back to the board's size; whoever may change the canvas keeps it as the
 * board's.
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
  onResizeBoard,
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
  /**
   * Resizes a board on the canvas, as its handles do while the canvas is edited: Keep this size.
   * Absent for whoever may not change the canvas.
   */
  readonly onResizeBoard?: (id: string, box: Box) => void
}) {
  const messages = useArtifactMessages().canvas
  const index = boards.findIndex((board) => board.id === id)
  const board = boards[index]
  const previous = boards[index - 1]
  const next = boards[index + 1]

  const [kept, setKept] = useState<PageSize | null>(null)
  const own = useMemo(() => ({ w: board?.w ?? 1, h: board?.h ?? 1 }), [board?.w, board?.h])
  const size = useShownSize(id, own)
  const { shown, resized, suggestions } = size

  const [stage, setStage] = useState<HTMLDivElement | null>(null)
  const view = useSize(stage)
  const zoom = usePageZoom({ id, page: shown, view, stage })

  /** A size picked from the menu: the page fitted at it. */
  const pickSize = (picked: PageSize, name: SizeName) => {
    size.pick(picked, name)
    zoom.fit("open")
  }

  const reset = () => {
    size.reset()
    zoom.fit("open")
  }

  /** A resize ends: what it snapped to says whether its width carries to the other boards. */
  const resizedBy = (snapped: SnappedSize | null) => {
    zoom.release()
    if (snapped) size.settle(snapped)
  }

  const keep =
    onResizeBoard && board
      ? () => {
          onResizeBoard(board.id, { x: board.x, y: board.y, w: shown.w, h: shown.h })
          size.keep()
          setKept(shown)
        }
      : undefined

  useEffect(() => {
    if (!kept) return
    const timer = window.setTimeout(() => setKept(null), KEPT_MS)
    return () => window.clearTimeout(timer)
  }, [kept])

  const { step, zoomTo, zoomBy } = zoom
  const zoomStep = useCallback(
    (to: FrameZoomStep) => (to === "actual" ? zoomTo(1) : step(to)),
    [step, zoomTo]
  )
  const onZoom = useCallback(
    (by: FrameZoom) => ("step" in by ? zoomStep(by.step) : zoomBy(by.factor, by.at)),
    [zoomStep, zoomBy]
  )

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
      // ⌘ +, − and 0 zoom the board, not the app around it.
      if (event.metaKey || event.ctrlKey) {
        const to = zoomKey(event)
        if (to) {
          event.preventDefault()
          zoomStep(to)
        }
        return
      }
      if (event.altKey) return
      // Keys typed into a field are the field's, and a menu's are its own; arrows on the page's
      // handles and their suggestions resize it.
      const target = event.target instanceof Element ? event.target : null
      if (
        target?.closest(
          "input, textarea, select, [contenteditable], [data-board-tools], [role=menu]"
        )
      ) {
        return
      }
      if (event.key !== "Escape" && target?.closest("[data-page-resizer]")) return
      if (event.key === "Escape") {
        if (!onEscape?.()) onClose()
      } else if (event.key === "ArrowLeft" && previous) onOpen(previous.id)
      else if (event.key === "ArrowRight" && next) onOpen(next.id)
      else return
      event.preventDefault()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [previous, next, onOpen, onClose, onEscape, zoomStep])

  if (!board) return null
  const title = board.title ?? board.id
  const { scale, placement } = zoom
  const picture = resized ? undefined : pictureOf?.(board.id)

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
        {mode === "edit" || mode === "comment" ? (
          <span className="hidden min-w-0 truncate text-xs text-muted-foreground @5xl/canvas:inline">
            {mode === "edit" ? messages.edit.hint : messages.comments.modeHint}
          </span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center">
          <SizeControls
            shown={shown}
            board={own}
            suggestions={suggestions}
            kept={kept}
            onPick={pickSize}
            onReset={reset}
            onKeep={keep}
          />
          {tools}
        </div>
        <span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground tabular-nums max-sm:hidden">
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
      <div className="relative min-h-0 flex-1 bg-muted/40">
        {/* Scrolled over the page when it is larger than the view; pinched, zoomed instead. */}
        <div
          ref={setStage}
          data-board-stage=""
          className="absolute inset-0 touch-pan-x touch-pan-y overflow-auto overscroll-contain"
          onDoubleClick={(event) => {
            if ((event.target as Element).closest("[data-board-page]")) return
            const at = zoom.pageAt(event.clientX, event.clientY)
            if (at) zoom.toggle(at)
          }}
        >
          {placement && scale > 0 ? (
            <div className="relative" style={{ width: placement.width, height: placement.height }}>
              {/* The box the page takes on screen; the page inside is laid out at its size. */}
              <div
                key={board.id}
                data-board-page=""
                className={cn(
                  "group/page sixb-canvas-surface absolute motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-97 motion-safe:duration-300 motion-safe:ease-out",
                  zoom.settling ? "motion-safe:transition-[left,top] motion-safe:ease-out" : null
                )}
                style={{
                  left: placement.left,
                  top: placement.top,
                  width: shown.w * scale,
                  height: shown.h * scale,
                }}
              >
                <BoardStage
                  version={version}
                  board={board}
                  size={shown}
                  title={title}
                  scale={scale}
                  live={live}
                  canvas={canvas}
                  mode={mode}
                  pins={pins.filter((pin) => pin.board === board.id)}
                  activePin={activePin}
                  draft={draft?.board === board.id ? draft : null}
                  // Its picture is of the board at its own size.
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
                  onContentHeight={size.onContentHeight}
                  onZoom={onZoom}
                />
                <PageResizer
                  size={shown}
                  scale={scale}
                  suggestions={suggestions}
                  stage={stage}
                  onStart={zoom.hold}
                  onResize={size.resize}
                  onEnd={resizedBy}
                />
              </div>
            </div>
          ) : null}
        </div>

        <ZoomBar
          zoom={scale}
          fitLabel={messages.fitPage}
          onZoomOut={() => zoom.step("out")}
          onActualSize={() => zoom.zoomTo(1)}
          onZoomIn={() => zoom.step("in")}
          onFit={() => zoom.fit("whole")}
          className="absolute bottom-3 left-3 z-20"
        />
      </div>
    </div>
  )
}

/** ⌘ or Ctrl with +, − or 0 as a zoom step. */
export function zoomKey(event: KeyboardEvent): FrameZoomStep | null {
  if (event.altKey) return null
  if (event.key === "=" || event.key === "+") return "in"
  if (event.key === "-") return "out"
  if (event.key === "0") return "actual"
  return null
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
