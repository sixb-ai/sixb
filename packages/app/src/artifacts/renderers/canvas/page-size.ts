import { ARTIFACT_LIMITS } from "@sixb/core/artifacts"

// An opened board's page as the reader looks at it: the size it is laid out at, which they may
// change for themselves, the sizes it snaps to, and how far it is zoomed.

/** A page's size as it is laid out, in its own pixels. */
export interface PageSize {
  readonly w: number
  readonly h: number
}

/** What a suggested size is: the board's own, the page's full height, or a common screen. */
export type SizeName = "board" | "full" | "phone" | "tablet" | "laptop" | "desktop"

/** A size the page snaps to: a width, a height, or both. */
export interface SizeSuggestion {
  readonly name: SizeName
  readonly w?: number
  readonly h?: number
}

/** The sizes a resize snaps to, by the edge it moves. */
export interface SizeSuggestions {
  readonly widths: readonly SizeSuggestion[]
  readonly heights: readonly SizeSuggestion[]
  /** Both at once, for the corner: the board's size and the common screens'. */
  readonly sizes: readonly SizeSuggestion[]
  /** The least the page is laid out at: {@link PAGE_MIN}, or the board's own size when less. */
  readonly least: PageSize
}

/** The edges a resize moves. */
export interface ResizedEdges {
  readonly w: boolean
  readonly h: boolean
}

/** The common screens' widths a page is laid out at, and their sizes as a whole. */
export const SCREENS = [
  { name: "phone", w: 390, h: 844 },
  { name: "tablet", w: 768, h: 1024 },
  { name: "laptop", w: 1280 },
  { name: "desktop", w: 1440, h: 900 },
] as const satisfies readonly SizeSuggestion[]

/** Whether a size is a common screen's: its width carries to the other boards. */
export function isScreen(name: SizeName): boolean {
  return SCREENS.some((screen) => screen.name === name)
}

/**
 * The least a page is laid out at, which still reads as a page, and the most, the largest board a
 * canvas holds.
 */
export const PAGE_MIN: PageSize = { w: 240, h: 160 }
export const PAGE_MAX = ARTIFACT_LIMITS.maxCanvasItemSize

/** The grid a resize moves along, the canvas's own. */
const GRID = 8

/** How near, in pixels on screen, a suggested size pulls the edge being dragged to it. */
export const SNAP_REACH = 8

/** The zoom an opened board ranges over, and how much a step moves it, as the canvas's do. */
export const ZOOM_MIN = 0.1
export const ZOOM_MAX = 2.5
const ZOOM_STEP = 1.2

/** A size kept within what a page is laid out at, in whole pixels. */
export function clampSize(size: PageSize, least: PageSize = PAGE_MIN): PageSize {
  return {
    w: Math.round(Math.min(PAGE_MAX, Math.max(least.w, size.w))),
    h: Math.round(Math.min(PAGE_MAX, Math.max(least.h, size.h))),
  }
}

/**
 * What a page snaps to: the board's own size, its full height once the page reports it, and the
 * common screens. A size the board's own already names is not named twice.
 */
export function sizeSuggestions(board: PageSize, content: number | null): SizeSuggestions {
  const least = { w: Math.min(PAGE_MIN.w, board.w), h: Math.min(PAGE_MIN.h, board.h) }
  const full =
    content === null
      ? []
      : [{ name: "full" as const, h: clampSize({ ...board, h: content }, least).h }]
  const widths = distinct([{ name: "board", w: board.w }, ...SCREENS], (each) => each.w)
  const heights = distinct([{ name: "board", h: board.h }, ...full], (each) => each.h)
  const sizes = distinct(
    [{ name: "board", w: board.w, h: board.h }, ...SCREENS.filter((screen) => "h" in screen)],
    (each) => `${each.w}×${each.h}`
  )
  return { widths, heights, sizes, least }
}

function distinct(
  suggestions: readonly SizeSuggestion[],
  key: (suggestion: SizeSuggestion) => unknown
): SizeSuggestion[] {
  const seen = new Set<unknown>()
  return suggestions.filter((suggestion) => {
    const value = key(suggestion)
    if (seen.has(value)) return false
    seen.add(value)
    return true
  })
}

/** Where a resize leaves the page, and the suggestions it snapped to. */
export interface SnappedSize {
  readonly size: PageSize
  readonly w: SizeSuggestion | null
  readonly h: SizeSuggestion | null
}

/**
 * Where a resize puts the page: each moved edge on the nearest suggestion within `reach`, in the
 * page's pixels, else on the grid; the corner on a whole suggested size when both edges are
 * near one. `free`, as with Alt held, it goes where the pointer is.
 */
export function snapSize(
  raw: PageSize,
  edges: ResizedEdges,
  suggestions: SizeSuggestions,
  reach: number,
  free = false
): SnappedSize {
  const { least } = suggestions
  if (free) return { size: clampSize(raw, least), w: null, h: null }

  if (edges.w && edges.h) {
    const size = nearest(suggestions.sizes, (each) =>
      Math.abs((each.w ?? 0) - raw.w) <= reach && Math.abs((each.h ?? 0) - raw.h) <= reach
        ? Math.hypot((each.w ?? 0) - raw.w, (each.h ?? 0) - raw.h)
        : null
    )
    if (size?.w !== undefined && size.h !== undefined) {
      return { size: clampSize({ w: size.w, h: size.h }, least), w: size, h: size }
    }
  }

  const w = edges.w ? nearestOn(suggestions.widths, "w", raw.w, reach) : null
  const h = edges.h ? nearestOn(suggestions.heights, "h", raw.h, reach) : null
  const size = clampSize(
    {
      w: edges.w ? (w?.w ?? onGrid(raw.w)) : raw.w,
      h: edges.h ? (h?.h ?? onGrid(raw.h)) : raw.h,
    },
    least
  )
  return { size, w, h }
}

function nearestOn(
  suggestions: readonly SizeSuggestion[],
  axis: "w" | "h",
  value: number,
  reach: number
): SizeSuggestion | null {
  return nearest(suggestions, (each) => {
    const at = each[axis]
    return at !== undefined && Math.abs(at - value) <= reach ? Math.abs(at - value) : null
  })
}

/** The suggestion at the least distance; null when none is within reach. */
function nearest(
  suggestions: readonly SizeSuggestion[],
  distance: (suggestion: SizeSuggestion) => number | null
): SizeSuggestion | null {
  let best: SizeSuggestion | null = null
  let least = Number.POSITIVE_INFINITY
  for (const suggestion of suggestions) {
    const away = distance(suggestion)
    if (away === null || away >= least) continue
    best = suggestion
    least = away
  }
  return best
}

function onGrid(value: number): number {
  return Math.round(value / GRID) * GRID
}

/** The room an opened board is fitted into, on screen. */
export interface Room {
  readonly width: number
  readonly height: number
}

/**
 * The zoom a page opens at. One taller than wide reads like a document: fitted to the room's
 * width and scrolled, never enlarged past its own size, unless it nearly fits whole, which it
 * then does. Any other opens whole. `whole` always fits it whole.
 */
export function fitScale(page: PageSize, room: Room, how: "open" | "whole"): number {
  const whole = clampZoom(Math.min(room.width / page.w, room.height / page.h))
  if (how === "whole" || page.h <= page.w) return whole

  const width = clampZoom(Math.min(room.width / page.w, Math.max(whole, 1)))
  // A few pixels of scrolling read as a page cut off: it shows whole instead.
  return whole >= width * 0.8 ? whole : width
}

/** One step of ⌘+ or ⌘−, or of the zoom bar's buttons: a fifth more, or less. */
export function zoomStep(scale: number, direction: "in" | "out"): number {
  return clampZoom(direction === "in" ? scale * ZOOM_STEP : scale / ZOOM_STEP)
}

export function clampZoom(scale: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale))
}

/** Whether two sizes are one. */
export function sameSize(left: PageSize, right: PageSize): boolean {
  return left.w === right.w && left.h === right.h
}
