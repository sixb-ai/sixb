import type { CanvasEnd, CanvasItem, CanvasTextSize } from "./canvas"

// How a canvas is shown: the app's viewer draws it at these sizes, and whatever pictures a canvas
// as a reader sees it, such as the Agent's overview of one, follows them. Browser-safe: the app
// reads them from @sixb/core/artifacts, the only core subpath it may import.

/** The size a text of each size is drawn at, in canvas pixels. */
export const CANVAS_TEXT_PIXELS: Readonly<Record<CanvasTextSize, number>> = {
  s: 14,
  m: 18,
  l: 28,
  xl: 44,
  // A title over a group of full-size screens or frames, which a canvas opens far out on.
  xxl: 120,
}

/** The margin a canvas opens with around everything on it, as a share of what it shows. */
export const CANVAS_FIT_PADDING = 0.12

/** A note's words: a wide note is read from further out, so its text is a little larger. */
export function canvasNoteFontSize(width: number): number {
  return Math.round(Math.min(22, Math.max(15, width / 13)))
}

/** A shape's words, larger in a larger shape, as a note's are. */
export function canvasShapeFontSize(width: number, height: number): number {
  return Math.round(Math.min(22, Math.max(15, Math.min(width, height * 2) / 12)))
}

/**
 * The widest a board's small preview is, in pixels: a viewer shows it while the board is drawn at
 * most this wide on screen, in device pixels, and the full one past it.
 */
export const SMALL_BOARD_PREVIEW_WIDTH = 480

/**
 * How the render worker renders a canvas's missing previews: `settleMs` after the last write that
 * asked; each attempt within `timeoutMs`, up to `attempts`, `backoffMs` apart.
 *
 * `settleMs` is longer than a live canvas waits between two write-backs (`SAVE_MAX_MS` in the
 * server's live rooms), so someone typing in a board is rendered once they pause.
 */
export const BOARD_PREVIEW_JOB = {
  settleMs: 15_000,
  timeoutMs: 5 * 60_000,
  attempts: 3,
  backoffMs: 60_000,
} as const

/**
 * How long after a canvas version is published a missing board preview is still worth waiting
 * for: the job's settling, then every one of its attempts and the waits between them. Past it,
 * nothing more will come, so the server says so and a viewer stops asking.
 */
export const BOARD_PREVIEW_WAIT_MS =
  BOARD_PREVIEW_JOB.settleMs +
  BOARD_PREVIEW_JOB.attempts * BOARD_PREVIEW_JOB.timeoutMs +
  (BOARD_PREVIEW_JOB.attempts - 1) * BOARD_PREVIEW_JOB.backoffMs

/** A box on the canvas, in canvas pixels. */
export interface CanvasBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Room between an item's edge and the arrow that leaves or meets it. */
const ARROW_GAP = 10

/**
 * Where an arrow between two boxes is drawn: straight, from the side of one that faces the
 * other's center to the side of the other, each a little off its box. A point's box, one pixel
 * wide, is its center.
 */
export function canvasArrowLine(
  from: CanvasBox,
  to: CanvasBox
): { readonly start: CanvasPoint; readonly end: CanvasPoint } {
  return { start: exitPoint(from, center(to)), end: exitPoint(to, center(from)) }
}

export interface CanvasPoint {
  readonly x: number
  readonly y: number
}

/**
 * An item's box before anything is measured, as the app draws it: a text's reckoned from its words
 * at its size, wrapped at its width when it has one, each line at the app's line height; a note
 * without a height as tall as its words take, and never shorter than the app draws it. An arrow
 * has none.
 */
export function canvasItemBox(item: CanvasItem): CanvasBox | null {
  switch (item.type) {
    case "arrow":
      return null
    case "text": {
      const size = CANVAS_TEXT_PIXELS[item.size]
      const lineHeight = item.size === "s" || item.size === "m" ? 1.45 : 1.15
      const longest = Math.max(...item.text.split("\n").map((line) => line.length))
      const width = item.w ?? Math.min(longest * size * LETTER_WIDTH, 1600)
      return {
        x: item.x,
        y: item.y,
        width,
        height: size * lineHeight * wrappedLines(item.text, width, size),
      }
    }
    case "note": {
      const size = canvasNoteFontSize(item.w)
      const written = size * 1.4 * wrappedLines(item.text, item.w - size * 2, size) + size * 1.7
      const height = item.h ?? Math.max(Math.min(item.w, 112), written)
      return { x: item.x, y: item.y, width: item.w, height }
    }
    default:
      return { x: item.x, y: item.y, width: item.w, height: item.h }
  }
}

/** An average letter's width, as a share of the text's size. */
const LETTER_WIDTH = 0.55

/** How many lines words take at a width, each of their own lines wrapped at it. */
function wrappedLines(text: string, width: number, size: number): number {
  const perLine = Math.max(1, Math.floor(width / (size * LETTER_WIDTH)))
  return text
    .split("\n")
    .reduce((total, line) => total + Math.max(1, Math.ceil(line.length / perLine)), 0)
}

/** An arrow's end as a box: an item's, or a point's, one pixel wide. */
export function canvasEndBox(
  end: CanvasEnd,
  boxes: ReadonlyMap<string, CanvasBox>
): CanvasBox | undefined {
  return typeof end === "string" ? boxes.get(end) : { x: end.x, y: end.y, width: 1, height: 1 }
}

function center(box: CanvasBox): CanvasPoint {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/** Where the line from a box's center toward a point leaves the box, plus the arrow's gap. */
function exitPoint(box: CanvasBox, toward: CanvasPoint): CanvasPoint {
  const { x: cx, y: cy } = center(box)
  const dx = toward.x - cx
  const dy = toward.y - cy
  if ((dx === 0 && dy === 0) || box.width <= 1) return { x: cx, y: cy }

  const scale = Math.min(
    dx === 0 ? Number.POSITIVE_INFINITY : box.width / 2 / Math.abs(dx),
    dy === 0 ? Number.POSITIVE_INFINITY : box.height / 2 / Math.abs(dy)
  )
  const length = Math.hypot(dx, dy)
  const reach = scale * length + ARROW_GAP
  return { x: cx + (dx / length) * reach, y: cy + (dy / length) * reach }
}
