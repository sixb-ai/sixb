import type { FrameEvent, FramePan, FramePoint, FrameZoomStep } from "@sixb/core/artifacts"
import { useReactFlow, useStoreApi } from "@xyflow/react"
import { type RefObject, useEffect, useMemo, useRef } from "react"
import { LIVE_FROM_SCALE } from "./board"
import type { Box } from "./draft"
import { zoomKey } from "./focus"

// A board running on the canvas is a page the reader uses in place, in read mode. Its frame takes
// the reader's clicks, keys and text, and hands the canvas, through the port each load is given,
// what moves it:
//
//   frame ── pan ────▶ the canvas pans: the wheel unless the page scrolls it, or a finger's drag
//         ── zoom ───▶ the canvas zooms around the pointer, or by a step
//         ── space ──▶ Space held: a drag anywhere pans, the boards' pages let it through
//         ── press ──▶ the canvas glides to the board an arrow with those words leads to
//         ◀─ canvas ── whether the canvas is panning by the wheel, so a page coming under a still
//                      pointer keeps panning it instead of scrolling itself

/** How far a wheel's turn pans the canvas over a board, as React Flow's `panOnScrollSpeed` does. */
const WHEEL_PAN_SPEED = 0.5

/** How long after its last wheel turn the canvas still pans: React Flow's own pause. */
const WHEEL_PAUSE_MS = 150

/** How long the canvas takes to glide to the board an arrow leads to. */
const GLIDE_MS = 420

/** How long a zoom step takes, as the zoom bar's. */
const STEP_MS = 220

/** What a glide leaves above and beside a board too large for the view. */
const GLIDE_MARGIN = 32

/** What takes Space itself in the app: a field types it, a control presses. */
const KEYED = "input, textarea, select, button, a[href], [contenteditable], [role=menu]"

/** What the canvas does with what its running boards hand it. */
export interface BoardGestures {
  /** Whether the canvas is panning by the wheel now. */
  readonly moving: () => boolean
  /** Tells `listener` each time the canvas starts or stops panning by the wheel. */
  readonly onMoving: (listener: (moving: boolean) => void) => () => void
  /** What `board`'s frame sent through its port; `page` is where its page is drawn. */
  readonly receive: (board: string, event: FrameEvent, page: Element | null) => void
  /** Glides the canvas to show `box`, as a press on an arrow's label does. */
  readonly glide: (box: Box) => void
}

/**
 * Where the view goes to show `box` in a `view` this large, from `zoom`: centered, never closer
 * than the reader is, and further only as far as it takes to fit, though never so far the board
 * stops running, unless the reader is further already. A board still too large starts at the
 * view's top left, as a page is read.
 */
export function glideView(
  box: Box,
  view: { readonly width: number; readonly height: number },
  zoom: number,
  padding: number
): { readonly x: number; readonly y: number; readonly zoom: number } {
  const fit = Math.min(view.width / (box.w * (1 + padding)), view.height / (box.h * (1 + padding)))
  const next = Math.min(zoom, Math.max(fit, Math.min(zoom, LIVE_FROM_SCALE)))

  const width = box.w * next
  const height = box.h * next
  const left = width <= view.width ? (view.width - width) / 2 : GLIDE_MARGIN
  const top = height <= view.height ? (view.height - height) / 2 : GLIDE_MARGIN
  return { x: left - box.x * next, y: top - box.y * next, zoom: next }
}

/**
 * The canvas's side of its running boards' gestures, and of its own keys while it is read: Space
 * held over it lets a drag pan across the boards' pages, and ⌘ +, − and 0 zoom it, never the
 * browser, while it has the pointer or the focus and no board is opened.
 */
export function useBoardGestures({
  root,
  pointed,
  reading,
  opened,
  padding,
  onPress,
}: {
  readonly root: RefObject<HTMLElement | null>
  /** Whether the pointer is over the canvas. */
  readonly pointed: RefObject<boolean>
  /** Whether the reader reads the canvas: neither editing it nor placing a comment. */
  readonly reading: boolean
  /** Whether a board is opened over the canvas, which takes the keys itself. */
  readonly opened: boolean
  readonly padding: number
  /** The reader pressed `text` in `board`'s page. */
  readonly onPress: (board: string, text: string) => void
}): BoardGestures {
  const store = useStoreApi()
  const { setViewport, zoomIn, zoomOut, zoomTo } = useReactFlow()
  const pressRef = useRef(onPress)
  pressRef.current = onPress

  const gestures = useMemo(() => {
    let moving = false
    let pause: ReturnType<typeof setTimeout> | undefined
    const listeners = new Set<(moving: boolean) => void>()
    const tell = (next: boolean) => {
      if (moving === next) return
      moving = next
      for (const listener of listeners) listener(next)
    }

    /** The canvas panned by the wheel: it is panning until the wheel pauses. */
    const wheeled = () => {
      tell(true)
      clearTimeout(pause)
      pause = setTimeout(() => tell(false), WHEEL_PAUSE_MS)
    }

    const view = () => {
      const [x, y, zoom] = store.getState().transform
      return { x, y, zoom }
    }

    /** Zooms by `factor` around a point on screen, which stays where it is. */
    const zoomAround = (factor: number, at: FramePoint) => {
      const { minZoom, maxZoom, domNode } = store.getState()
      const bounds = domNode?.getBoundingClientRect()
      if (!bounds) return

      const { x, y, zoom } = view()
      const next = Math.min(maxZoom, Math.max(minZoom, zoom * factor))
      const left = at.x - bounds.left
      const top = at.y - bounds.top
      void setViewport({
        x: left - ((left - x) * next) / zoom,
        y: top - ((top - y) * next) / zoom,
        zoom: next,
      })
    }

    const pan = ({ x: right, y: down, by }: FramePan) => {
      const speed = by === "wheel" ? WHEEL_PAN_SPEED : 1
      const { x, y, zoom } = view()
      void setViewport({ x: x - right * speed, y: y - down * speed, zoom })
      if (by === "wheel") wheeled()
    }

    const step = (to: FrameZoomStep) => {
      if (to === "in") void zoomIn({ duration: STEP_MS })
      else if (to === "out") void zoomOut({ duration: STEP_MS })
      else void zoomTo(1, { duration: STEP_MS })
    }

    /** While Space is held, a drag across a board's page pans, as anywhere on the canvas. */
    const hold = (down: boolean) => {
      root.current?.toggleAttribute("data-panning", down)
    }

    return {
      wheeled,
      step,
      hold,
      moving: () => moving,
      onMoving: (listener: (moving: boolean) => void) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      receive: (board: string, event: FrameEvent, page: Element | null) => {
        switch (event.event) {
          case "zoom": {
            if ("step" in event.params) {
              step(event.params.step)
              return
            }
            // The frame's pixels are the canvas's, drawn at its zoom.
            const bounds = page?.getBoundingClientRect()
            if (!bounds) return
            const { zoom } = view()
            const { factor, at } = event.params
            zoomAround(factor, { x: bounds.left + at.x * zoom, y: bounds.top + at.y * zoom })
            return
          }
          case "pan":
            pan(event.params)
            return
          case "space":
            hold(event.params.down)
            return
          case "press":
            pressRef.current(board, event.params.text)
            return
          default:
            return
        }
      },
      glide: (box: Box) => {
        const { width, height } = store.getState()
        const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
        void setViewport(glideView(box, { width, height }, view().zoom, padding), {
          duration: still ? 0 : GLIDE_MS,
        })
      },
      stop: () => {
        clearTimeout(pause)
        tell(false)
      },
    }
  }, [store, setViewport, zoomIn, zoomOut, zoomTo, root, padding])

  useEffect(() => gestures.stop, [gestures])

  // A wheel turned over the canvas itself pans it: a board coming under the pointer goes on
  // panning it.
  useEffect(() => {
    const here = root.current
    if (!here) return

    const onWheel = (event: WheelEvent) => {
      if (event.target instanceof Element && event.target.closest(".react-flow")) gestures.wheeled()
    }
    here.addEventListener("wheel", onWheel, { capture: true, passive: true })
    return () => here.removeEventListener("wheel", onWheel, { capture: true })
  }, [root, gestures])

  // The canvas's own keys, while it has the pointer or the focus: a board's page sends its own
  // through the port.
  useEffect(() => {
    if (opened) return

    const here = () => {
      const canvas = root.current
      return canvas !== null && (pointed.current || canvas.contains(document.activeElement))
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey) {
        const to = event.type === "keydown" ? zoomKey(event) : null
        if (!to || !here()) return
        event.preventDefault()
        gestures.step(to)
        return
      }
      if (!reading || event.key !== " " || event.altKey) return

      const down = event.type === "keydown"
      if (down) {
        if (!here() || (event.target instanceof Element && event.target.closest(KEYED))) return
        event.preventDefault()
      }
      gestures.hold(down)
    }
    const release = () => gestures.hold(false)

    window.addEventListener("keydown", onKey)
    window.addEventListener("keyup", onKey)
    window.addEventListener("blur", release)
    return () => {
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("keyup", onKey)
      window.removeEventListener("blur", release)
      release()
    }
  }, [opened, reading, root, pointed, gestures])

  return gestures
}
