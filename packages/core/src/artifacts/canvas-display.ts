import type { CanvasTextSize } from "./canvas"

// How a canvas is shown: the app's viewer draws it at these sizes, and whatever pictures a canvas
// as a reader sees it, such as the Agent's overview of one, follows them. Browser-safe: the app
// reads them from @sixb/core/artifacts, the only core subpath it may import.

/** The size a text of each size is drawn at, in canvas pixels. */
export const CANVAS_TEXT_PIXELS: Readonly<Record<CanvasTextSize, number>> = {
  s: 14,
  m: 18,
  l: 28,
  xl: 44,
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
 * How the agent worker renders the previews nobody else rendered: after `graceMs` when the
 * publisher renders its own, as the Agent's layout check does within its 120 seconds; each
 * attempt within `timeoutMs`, up to `attempts`, `backoffMs` apart.
 */
export const BOARD_PREVIEW_JOB = {
  graceMs: 180_000,
  timeoutMs: 5 * 60_000,
  attempts: 3,
  backoffMs: 60_000,
} as const

/**
 * How long after a canvas version is published a missing board preview is still worth waiting
 * for: the job's grace, then every one of its attempts and the waits between them. Past it,
 * nothing more will come, so the server says so and a viewer stops asking.
 */
export const BOARD_PREVIEW_WAIT_MS =
  BOARD_PREVIEW_JOB.graceMs +
  BOARD_PREVIEW_JOB.attempts * BOARD_PREVIEW_JOB.timeoutMs +
  (BOARD_PREVIEW_JOB.attempts - 1) * BOARD_PREVIEW_JOB.backoffMs
