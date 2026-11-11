import { cn } from "@sixb/ui/lib/utils"
import {
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react"
import { useArtifactMessages } from "../../messages"
import {
  clampSize,
  type PageSize,
  type ResizedEdges,
  type SizeSuggestion,
  type SizeSuggestions,
  SNAP_REACH,
  type SnappedSize,
  snapSize,
} from "./page-size"

/** The handles a page is resized by: its right edge, its bottom edge, and the corner between. */
type Edge = "right" | "bottom" | "corner"

const EDGES: Readonly<Record<Edge, ResizedEdges>> = {
  right: { w: true, h: false },
  bottom: { w: false, h: true },
  corner: { w: true, h: true },
}

/** How far an arrow key moves an edge, and with Shift. */
const KEY_STEP = 8
const KEY_LEAP = 64

/** A drag under way: from where, and where it is now. */
interface Drag {
  readonly edge: Edge
  readonly from: PageSize
  readonly x: number
  readonly y: number
  readonly pointer: number
  /** Where the stage was scrolled as it started: what it scrolls since moves the edge too. */
  readonly scrolled: { readonly x: number; readonly y: number }
  /** Where the pointer is, and whether Alt is held, for the edge to move without it. */
  readonly at: { readonly x: number; readonly y: number }
  readonly free: boolean
  readonly snapped: SnappedSize
}

/**
 * How near the stage's edge the pointer scrolls it, and how fast at most, per frame: never past
 * a suggestion's reach both ways, so the edge never skips one.
 */
const SCROLL_ZONE = 40
const SCROLL_SPEED = SNAP_REACH * 2
/** How long scrolling rests on a suggested size it reaches, for the reader to let go there. */
const DETENT_MS = 500

/**
 * An opened board's page resized as the reader likes, for them alone: its right edge, its bottom
 * edge, or the corner, dragged or moved with the arrow keys. A drag snaps to the suggested sizes
 * within a few pixels on screen, drawn as guides with their name, and to the canvas's grid
 * otherwise; Alt lets it go where the pointer is. Double-clicking the bottom edge shows the full
 * page. Esc puts a drag back where it started.
 */
export function PageResizer({
  size,
  scale,
  suggestions,
  stage,
  onStart,
  onResize,
  onEnd,
}: {
  readonly size: PageSize
  readonly scale: number
  readonly suggestions: SizeSuggestions
  /** What scrolls over the page: a drag near its edge scrolls it, the edge following. */
  readonly stage: HTMLElement | null
  /** A resize starts: the page stays where it is on screen, at its zoom. */
  readonly onStart: () => void
  readonly onResize: (size: PageSize) => void
  /** A resize ends, at the suggestions it snapped to: none for a free one, or one put back. */
  readonly onEnd: (snapped: SnappedSize | null) => void
}) {
  const messages = useArtifactMessages().canvas.size
  const [drag, setDrag] = useState<Drag | null>(null)
  // The drag as the pointer's events read it, ahead of what is drawn.
  const dragging = useRef<Drag | null>(null)
  const update = useCallback((next: Drag | null) => {
    dragging.current = next
    setDrag(next)
  }, [])

  const move = useCallback(
    (at: { readonly x: number; readonly y: number }, free: boolean) => {
      const current = dragging.current
      if (!current) return

      const edges = EDGES[current.edge]
      const dx = at.x - current.x + (stage ? stage.scrollLeft - current.scrolled.x : 0)
      const dy = at.y - current.y + (stage ? stage.scrollTop - current.scrolled.y : 0)
      const raw = {
        w: current.from.w + (edges.w ? dx / scale : 0),
        h: current.from.h + (edges.h ? dy / scale : 0),
      }
      const snapped = snapSize(raw, edges, suggestions, SNAP_REACH / scale, free)
      update({ ...current, at, free, snapped })
      onResize(snapped.size)
    },
    [stage, scale, suggestions, onResize, update]
  )

  const end = useCallback(
    (cancel: boolean) => {
      const current = dragging.current
      if (!current) return

      if (cancel) onResize(current.from)
      update(null)
      onEnd(cancel ? null : current.snapped)
    },
    [onResize, onEnd, update]
  )

  // Near the stage's edge, or past it, the stage scrolls on, and the edge with it, as long as the
  // pointer stays there.
  const edge = drag?.edge
  useEffect(() => {
    if (!edge || !stage) return
    const edges = EDGES[edge]
    let frame = 0
    let resting: { at: SizeSuggestion; until: number } | null = null

    const roll = (now: number) => {
      frame = requestAnimationFrame(roll)
      const current = dragging.current
      if (!current) return

      const held = current.snapped.h ?? current.snapped.w
      if (held && held !== resting?.at) resting = { at: held, until: now + DETENT_MS }
      if (held && resting && now < resting.until) return

      const rect = stage.getBoundingClientRect()
      const speed = (past: number) => Math.min(1, Math.max(0, past / SCROLL_ZONE)) * SCROLL_SPEED
      // A drag started near the edge scrolls once it goes on past where it started.
      const x = edges.w ? speed(current.at.x - Math.max(rect.right - SCROLL_ZONE, current.x)) : 0
      const y = edges.h ? speed(current.at.y - Math.max(rect.bottom - SCROLL_ZONE, current.y)) : 0
      if (x === 0 && y === 0) return

      stage.scrollBy(x, y)
      move(current.at, current.free)
    }
    frame = requestAnimationFrame(roll)
    return () => cancelAnimationFrame(frame)
  }, [edge, stage, move])

  // While a drag goes on: Alt snaps or frees it as it is pressed, and Esc puts it back.
  useEffect(() => {
    if (!drag) return
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        end(true)
      } else if (event.key === "Alt") {
        const current = dragging.current
        if (current) move(current.at, event.type === "keydown")
      }
    }
    window.addEventListener("keydown", onKey, true)
    window.addEventListener("keyup", onKey, true)
    return () => {
      window.removeEventListener("keydown", onKey, true)
      window.removeEventListener("keyup", onKey, true)
    }
  }, [drag, end, move])

  const start = (edge: Edge) => (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)

    onStart()
    const at = { x: event.clientX, y: event.clientY }
    update({
      edge,
      from: size,
      x: at.x,
      y: at.y,
      pointer: event.pointerId,
      scrolled: { x: stage?.scrollLeft ?? 0, y: stage?.scrollTop ?? 0 },
      at,
      free: event.altKey,
      snapped: { size, w: null, h: null },
    })
  }

  const handlers = (edge: Edge) => ({
    onPointerDown: start(edge),
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      if (dragging.current?.pointer !== event.pointerId) return
      move({ x: event.clientX, y: event.clientY }, event.altKey)
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => {
      if (dragging.current?.pointer === event.pointerId) end(false)
    },
    onPointerCancel: (event: PointerEvent<HTMLElement>) => {
      if (dragging.current?.pointer === event.pointerId) end(true)
    },
  })

  /** A size set at once, by a key or a suggestion: a resize of its own. */
  const set = (next: PageSize, by: { w?: SizeSuggestion; h?: SizeSuggestion } = {}) => {
    const size = clampSize(next, suggestions.least)
    onStart()
    onResize(size)
    onEnd({ size, w: by.w ?? null, h: by.h ?? null })
  }

  const onKeyDown = (edge: Edge) => (event: KeyboardEvent<HTMLElement>) => {
    const edges = EDGES[edge]
    const by = event.shiftKey ? KEY_LEAP : KEY_STEP
    const moves: Record<string, PageSize> = edges.w
      ? { ArrowLeft: { ...size, w: size.w - by }, ArrowRight: { ...size, w: size.w + by } }
      : {}
    if (edges.h) {
      moves.ArrowUp = { ...size, h: size.h - by }
      moves.ArrowDown = { ...size, h: size.h + by }
    }
    const next = moves[event.key]
    if (!next) return

    event.preventDefault()
    event.stopPropagation()
    set(next)
  }

  const full = suggestions.heights.find((each) => each.name === "full")
  const edges = edge ? EDGES[edge] : null

  return (
    <div className="pointer-events-none absolute inset-0 z-[5]" data-page-resizer="">
      {drag ? (
        <div className="absolute inset-0 rounded-[inherit] ring-1 ring-primary" aria-hidden />
      ) : null}

      {drag && edges ? (
        <Guides
          size={drag.snapped.size}
          scale={scale}
          edges={edges}
          drag={drag}
          suggestions={suggestions}
        />
      ) : null}

      <Handle
        edge="right"
        label={messages.resizeWidth}
        value={size.w}
        active={edge === "right"}
        dragging={drag !== null}
        size={size}
        scale={scale}
        chips={suggestions.widths}
        onKeyDown={onKeyDown("right")}
        onPick={(suggestion) => set({ ...size, w: suggestion.w ?? size.w }, { w: suggestion })}
        {...handlers("right")}
      />
      <Handle
        edge="bottom"
        label={messages.resizeHeight}
        value={size.h}
        active={edge === "bottom"}
        dragging={drag !== null}
        size={size}
        scale={scale}
        chips={suggestions.heights}
        onKeyDown={onKeyDown("bottom")}
        onPick={(suggestion) => set({ ...size, h: suggestion.h ?? size.h }, { h: suggestion })}
        onDoubleClick={
          full?.h === undefined
            ? undefined
            : () => set({ ...size, h: full.h ?? size.h }, { h: full })
        }
        {...handlers("bottom")}
      />
      <Handle
        edge="corner"
        label={messages.resizeBoth}
        value={size.w}
        active={edge === "corner"}
        dragging={drag !== null}
        size={size}
        scale={scale}
        chips={suggestions.sizes}
        onKeyDown={onKeyDown("corner")}
        onPick={(suggestion) =>
          set(
            { w: suggestion.w ?? size.w, h: suggestion.h ?? size.h },
            { w: suggestion, h: suggestion }
          )
        }
        {...handlers("corner")}
      />

      {drag ? <Readout drag={drag} scale={scale} /> : null}
    </div>
  )
}

const HANDLE_PLACES: Readonly<Record<Edge, string>> = {
  right: "top-0 -right-[7px] h-full w-3.5 cursor-ew-resize",
  bottom: "left-0 -bottom-[7px] h-3.5 w-full cursor-ns-resize",
  corner: "-right-2.5 -bottom-2.5 size-5 cursor-nwse-resize",
}

/**
 * One handle: a strip along its edge, or a square at the corner, whose square shows as the
 * pointer comes over the page, as the canvas's handles do. Focused from the keyboard, the sizes it
 * snaps to are offered beside it.
 */
function Handle({
  edge,
  label,
  value,
  active,
  dragging,
  size,
  scale,
  chips,
  onKeyDown,
  onPick,
  onDoubleClick,
  ...pointer
}: {
  readonly edge: Edge
  readonly label: string
  readonly value: number
  readonly active: boolean
  readonly dragging: boolean
  readonly size: PageSize
  readonly scale: number
  readonly chips: readonly SizeSuggestion[]
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
  readonly onPick: (suggestion: SizeSuggestion) => void
  readonly onDoubleClick?: (() => void) | undefined
  readonly onPointerDown: (event: PointerEvent<HTMLElement>) => void
  readonly onPointerMove: (event: PointerEvent<HTMLElement>) => void
  readonly onPointerUp: (event: PointerEvent<HTMLElement>) => void
  readonly onPointerCancel: (event: PointerEvent<HTMLElement>) => void
}) {
  const messages = useArtifactMessages().canvas.size
  const [offering, setOffering] = useState(false)

  // The suggestions show while the handle, or one of them, has the keyboard's focus.
  const onFocus = (event: FocusEvent<HTMLElement>) => {
    if (event.target.matches(":focus-visible")) setOffering(true)
  }
  const onBlur = (event: FocusEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOffering(false)
  }

  return (
    <div onFocus={onFocus} onBlur={onBlur}>
      <div
        role="separator"
        tabIndex={0}
        aria-label={label}
        aria-orientation={edge === "bottom" ? "horizontal" : "vertical"}
        aria-valuenow={value}
        aria-valuetext={messages.dimensions(size.w, size.h)}
        title={edge === "bottom" ? messages.bottomHint : label}
        data-edge={edge}
        data-active={active ? "" : undefined}
        className={cn(
          "group/edge pointer-events-auto absolute touch-none outline-none",
          HANDLE_PLACES[edge]
        )}
        onKeyDown={onKeyDown}
        onDoubleClick={(event) => {
          event.stopPropagation()
          onDoubleClick?.()
        }}
        {...pointer}
      >
        {edge === "corner" ? null : (
          <span
            aria-hidden
            className={cn(
              "absolute bg-primary opacity-0 transition-opacity duration-150 group-hover/edge:opacity-60 group-data-[active]/edge:opacity-0",
              edge === "right" ? "inset-y-0 left-1/2 w-px" : "inset-x-0 top-1/2 h-px"
            )}
          />
        )}
        <span
          aria-hidden
          className={cn(
            "sixb-resize-handle absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 transition-opacity duration-150 group-focus-visible/edge:opacity-100 group-focus-visible/edge:ring-2 group-focus-visible/edge:ring-ring group-hover/page:opacity-100 [@media(hover:none)]:opacity-100",
            dragging ? "opacity-100" : "opacity-0"
          )}
        />
      </div>

      {offering && !dragging ? (
        <div
          role="group"
          aria-label={messages.suggestions}
          className="pointer-events-auto absolute z-10 flex max-w-72 flex-wrap justify-end gap-1"
          style={chipsPlace(edge, size, scale)}
        >
          {chips.map((chip) => (
            <button
              key={`${chip.name}-${chip.w ?? ""}-${chip.h ?? ""}`}
              type="button"
              onClick={() => onPick(chip)}
              className="rounded-md border border-border bg-background/95 px-1.5 py-0.5 text-[11px] leading-4 font-medium whitespace-nowrap text-foreground shadow-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
            >
              {messages.names[chip.name]}
              <span className="ml-1 text-muted-foreground tabular-nums">
                {messages.dimension(
                  edge === "bottom" ? undefined : chip.w,
                  edge === "right" ? undefined : chip.h
                )}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** Where a handle's suggestions sit: inside the page by its edge, where they stay in view. */
function chipsPlace(edge: Edge, size: PageSize, scale: number) {
  const right = size.w * scale
  const bottom = size.h * scale
  if (edge === "right")
    return { left: right - 14, top: bottom / 2, transform: "translate(-100%, -50%)" }
  if (edge === "bottom")
    return { left: right / 2, top: bottom - 14, transform: "translate(-50%, -100%)" }
  return { left: right - 14, top: bottom - 14, transform: "translate(-100%, -100%)" }
}

/**
 * What a drag snaps to, along the edges it moves: each suggestion a small mark past the page, and
 * the one it holds to a line across it.
 */
function Guides({
  size,
  scale,
  edges,
  drag,
  suggestions,
}: {
  readonly size: PageSize
  readonly scale: number
  readonly edges: ResizedEdges
  readonly drag: Drag
  readonly suggestions: SizeSuggestions
}) {
  const width = size.w * scale
  const height = size.h * scale
  const { w, h } = drag.snapped

  return (
    <div aria-hidden className="absolute inset-0">
      {edges.w
        ? suggestions.widths.map((each) =>
            each.w === undefined || each === w ? null : (
              <span
                key={`w-${each.name}`}
                className="absolute -top-3.5 h-2 w-px bg-muted-foreground/50"
                style={{ left: each.w * scale }}
              />
            )
          )
        : null}
      {edges.h
        ? suggestions.heights.map((each) =>
            each.h === undefined || each === h ? null : (
              <span
                key={`h-${each.name}`}
                className="absolute -right-3.5 h-px w-2 bg-muted-foreground/50"
                style={{ top: each.h * scale }}
              />
            )
          )
        : null}

      {w ? (
        <span
          className="absolute -top-4 -bottom-4 w-px bg-primary motion-safe:animate-in motion-safe:fade-in"
          style={{ left: width }}
        />
      ) : null}
      {h ? (
        <span
          className="absolute -right-4 -left-4 h-px bg-primary motion-safe:animate-in motion-safe:fade-in"
          style={{ top: height }}
        />
      ) : null}
    </div>
  )
}

/**
 * The page's size as a drag leaves it, inside the page by the handle that moves, so it stays in
 * view however near the stage's edge the page is: led, when it holds to suggestions, by their names.
 */
function Readout({ drag, scale }: { readonly drag: Drag; readonly scale: number }) {
  const messages = useArtifactMessages().canvas.size
  const { size, w, h } = drag.snapped
  const width = size.w * scale
  const height = size.h * scale
  const place =
    drag.edge === "right"
      ? { left: width - 12, top: height / 2, transform: "translate(-100%, -50%)" }
      : drag.edge === "bottom"
        ? { left: width / 2, top: height - 12, transform: "translate(-50%, -100%)" }
        : { left: width - 12, top: height - 12, transform: "translate(-100%, -100%)" }
  const names = [...new Set([w?.name, h?.name])].filter((name) => name !== undefined)

  return (
    <span role="status" className="absolute flex items-center gap-1" style={place}>
      {names.map((name) => (
        <span
          key={name}
          className="rounded-md bg-primary px-1.5 py-0.5 text-[11px] leading-4 font-medium whitespace-nowrap text-primary-foreground shadow-sm motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95"
        >
          {messages.names[name]}
        </span>
      ))}
      <span className="rounded-md bg-foreground px-1.5 py-0.5 text-[11px] leading-4 font-medium whitespace-nowrap text-background tabular-nums shadow-sm">
        {messages.dimensions(size.w, size.h)}
      </span>
    </span>
  )
}
