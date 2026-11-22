import type {
  VideoClip,
  VideoComposition,
  VideoFileTimeline,
  VideoTrack,
} from "@sixb/core/artifacts/live"
import { chapterStart } from "../chapters"

// The timeline's arithmetic, apart from what draws it: where an instant is on screen at a zoom,
// what an edge snaps to, which row a clip lies on, and the edit points the arrows jump between.
// Times are milliseconds from the video's start unless a name says a scene's.

/** The closest the timeline zooms out to, and in to, in pixels a second. */
export const MIN_PX_PER_SECOND = 2
export const MAX_PX_PER_SECOND = 640

/** How near, in pixels, an edge comes to something before it snaps to it. */
export const SNAP_PX = 8

/** The zoom that shows `durationMs` in `width` pixels, within the zoom's bounds. */
export function fitZoom(durationMs: number, width: number): number {
  if (durationMs <= 0 || width <= 0) return 100
  return clampZoom((width / durationMs) * 1000)
}

export function clampZoom(pxPerSecond: number): number {
  return Math.min(Math.max(pxPerSecond, MIN_PX_PER_SECOND), MAX_PX_PER_SECOND)
}

/**
 * Zooms by `factor` around `anchor`, a point of the visible timeline in pixels from its left edge:
 * the instant under it stays under it. Returns the zoom and where the timeline scrolls to.
 */
export function zoomAround(
  view: { readonly pxPerSecond: number; readonly scrollLeft: number },
  factor: number,
  anchor: number
): { readonly pxPerSecond: number; readonly scrollLeft: number } {
  const pxPerSecond = clampZoom(view.pxPerSecond * factor)
  const atMs = ((view.scrollLeft + anchor) / view.pxPerSecond) * 1000
  return { pxPerSecond, scrollLeft: Math.max(0, (atMs / 1000) * pxPerSecond - anchor) }
}

/**
 * `ms` moved to the nearest target within `thresholdMs`, and the target it snapped to; `ms` itself
 * when none is that near.
 */
export function snapTo(
  ms: number,
  targets: readonly number[],
  thresholdMs: number
): { readonly ms: number; readonly target?: number } {
  let best: number | undefined
  for (const target of targets) {
    if (Math.abs(target - ms) > thresholdMs) continue
    if (best === undefined || Math.abs(target - ms) < Math.abs(best - ms)) best = target
  }
  return best === undefined ? { ms } : { ms: best, target: best }
}

/**
 * Moves a clip `startMs` long by `durationMs` so that whichever of its edges comes nearest a
 * target snaps to it: a clip dragged lands its start or its end on a cut, as a magnetic timeline
 * does.
 */
export function snapMove(
  startMs: number,
  durationMs: number,
  targets: readonly number[],
  thresholdMs: number
): { readonly startMs: number; readonly target?: number } {
  const head = snapTo(startMs, targets, thresholdMs)
  const tail = snapTo(startMs + durationMs, targets, thresholdMs)
  const headBy = head.target === undefined ? Number.POSITIVE_INFINITY : Math.abs(head.ms - startMs)
  const tailBy =
    tail.target === undefined ? Number.POSITIVE_INFINITY : Math.abs(tail.ms - startMs - durationMs)

  if (headBy === Number.POSITIVE_INFINITY && tailBy === Number.POSITIVE_INFINITY) return { startMs }
  if (headBy <= tailBy)
    return { startMs: head.ms, ...(head.target === undefined ? {} : { target: head.target }) }
  return {
    startMs: tail.ms - durationMs,
    ...(tail.target === undefined ? {} : { target: tail.target }),
  }
}

/**
 * How far clips dragged together move, `deltaMs` at most: none before its composition's start,
 * `floorMs`, so the group keeps its shape where one of them stops.
 */
export function groupDelta(
  clips: readonly { readonly startMs: number; readonly floorMs: number }[],
  deltaMs: number
): number {
  return Math.max(deltaMs, ...clips.map((clip) => clip.floorMs - clip.startMs))
}

/** A clip where the timeline draws it: its time, and its top and height in pixels. */
export interface ClipBox<T> {
  readonly clip: T
  readonly startMs: number
  readonly endMs: number
  readonly top: number
  readonly height: number
}

/**
 * The clips a selection rectangle touches: each whose time and row it crosses, its corners in any
 * order, from where the drag started to where the pointer is.
 */
export function inRectangle<T>(
  boxes: readonly ClipBox<T>[],
  from: { readonly ms: number; readonly y: number },
  to: { readonly ms: number; readonly y: number }
): T[] {
  const [startMs, endMs] = [Math.min(from.ms, to.ms), Math.max(from.ms, to.ms)]
  const [top, bottom] = [Math.min(from.y, to.y), Math.max(from.y, to.y)]
  return boxes
    .filter(
      (box) =>
        box.startMs <= endMs &&
        box.endMs >= startMs &&
        box.top <= bottom &&
        box.top + box.height >= top
    )
    .map((box) => box.clip)
}

/** A clip as the timeline lays it out: where it plays in the video, on which track and row. */
export interface LaidClip {
  readonly clip: VideoClip
  /** Its file: a scene's, or `index.html` for the video's own. */
  readonly file: string
  readonly track: VideoTrack
  readonly startMs: number
  readonly endMs: number
  /** Whether it writes no length, and plays until its scene or file ends. */
  readonly open: boolean
  /**
   * Its row on its track: clips that overlap lie on rows of their own. On the picture and text
   * tracks, row 0 is the lowest, and a clip painted over another lies above it.
   */
  readonly row: number
  /**
   * The clip it is a part of, when that clip goes on in other scenes: its first part's
   * {@link clipKey}, whether it is that first part or the last, and whether a part of it lies
   * against it on its row, before it or after it.
   */
  readonly chain?: {
    readonly key: string
    readonly first: boolean
    readonly last: boolean
    readonly joinsBefore: boolean
    readonly joinsAfter: boolean
  }
}

/** A clip's name on the timeline: its file and its ref, the same for the same clip laid anew. */
export function clipKey(laid: { readonly file: string; readonly clip: { readonly ref: string } }) {
  return `${laid.file}#${laid.clip.ref}`
}

/** The clip a laid part belongs to, by the key of its first part: its own key when it is whole. */
export function chainKey(laid: LaidClip): string {
  return laid.chain?.key ?? clipKey(laid)
}

/**
 * The clips of a file, placed in the video: a scene's from its start, and each lasting its length,
 * or until its composition ends when it writes none. None shows past that end, where it is never
 * seen: footage longer than its scene, once the scene is trimmed, ends with it.
 */
export function layClips(
  timeline: VideoFileTimeline,
  file: string,
  offsetMs: number,
  endMs: number
): LaidClip[] {
  const placed = timeline.clips.map((clip) => {
    const startMs = offsetMs + clip.startMs
    const end = Math.max(
      startMs + 1,
      clip.durationMs === undefined ? endMs : Math.min(startMs + clip.durationMs, endMs)
    )
    return {
      clip,
      file,
      track: clip.track,
      startMs,
      endMs: end,
      open: clip.durationMs === undefined,
    }
  })

  return onRows(placed)
}

/**
 * Clips on rows of their own track, in the order they paint: a scene's in its file's order, and a
 * later scene's over an earlier one's, as a crossfade stacks them. On the picture and text tracks,
 * what paints over a clip lies above it, every editor's way: each on the row over the highest it
 * overlaps. Sounds stack nothing, and take the first row free where they start.
 */
export function onRows(placed: readonly Omit<LaidClip, "row">[]): LaidClip[] {
  const laid = new Map<VideoTrack, LaidClip[]>()
  return placed.map((each) => {
    const track = laid.get(each.track) ?? []
    laid.set(each.track, track)
    const overlapping = track.filter(
      (other) => other.startMs < each.endMs && each.startMs < other.endMs
    )

    let row = 0
    if (each.track === "sound") {
      while (overlapping.some((other) => other.row === row)) row += 1
    } else {
      row = Math.max(-1, ...overlapping.map((other) => other.row)) + 1
    }

    const placedClip = { ...each, row }
    track.push(placedClip)
    return placedClip
  })
}

/** How many rows each track needs, at least one. */
export function trackRows(clips: readonly LaidClip[]): Record<VideoTrack, number> {
  const rows: Record<VideoTrack, number> = { picture: 1, text: 1, sound: 1 }
  for (const clip of clips) rows[clip.track] = Math.max(rows[clip.track], clip.row + 1)
  return rows
}

/**
 * Every edit point of the video, in order: where each scene and each clip starts and ends. The
 * arrows jump between them, and edges snap to them.
 */
export function editPoints(composition: VideoComposition, clips: readonly LaidClip[]): number[] {
  const points = new Set<number>([0, composition.durationMs])
  for (const scene of composition.scenes) {
    points.add(scene.startMs)
    points.add(scene.startMs + scene.durationMs)
  }
  for (const clip of clips) {
    points.add(clip.startMs)
    if (!clip.open) points.add(clip.endMs)
  }
  return [...points].sort((a, b) => a - b)
}

/** The edit point after `ms`, or before it, if there is one. */
export function nextEditPoint(
  points: readonly number[],
  ms: number,
  direction: 1 | -1
): number | undefined {
  if (direction > 0) return points.find((point) => point > ms + 1)
  return [...points].reverse().find((point) => point < ms - 1)
}

/**
 * The ruler's marks at a zoom: a labelled mark every `step` and a small one between, the step the
 * smallest that leaves room for a label.
 */
export function rulerSteps(pxPerSecond: number): {
  readonly major: number
  readonly minor: number
} {
  const steps = [100, 250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000]
  const major = steps.find((step) => (step / 1000) * pxPerSecond >= 72) ?? 300_000
  const minor = major / (major === 250 || major === 15_000 ? 5 : major <= 1000 ? 5 : 4)
  return { major, minor }
}

/**
 * The scene a clip put at `ms` lands in, as the video's placement reads it: the one on top there,
 * the later in play order; in a gap, the next to start; past every scene, the last.
 */
export function sceneFor<T extends { readonly startMs: number; readonly durationMs: number }>(
  scenes: readonly T[],
  ms: number
): T | undefined {
  let found: T | undefined
  for (const scene of scenes) {
    if (scene.startMs <= ms && ms < scene.startMs + scene.durationMs) found = scene
  }
  return found ?? scenes.find((scene) => scene.startMs >= ms) ?? scenes.at(-1)
}

/** The scene playing at `ms`: the last to start by then, as the later one shows over the other. */
export function sceneAt<T extends { readonly startMs: number; readonly durationMs: number }>(
  scenes: readonly T[],
  ms: number
): T | undefined {
  let found: T | undefined
  for (const scene of scenes) {
    if (scene.startMs <= ms && ms < scene.startMs + scene.durationMs) found = scene
  }
  return found ?? scenes.at(-1)
}

/**
 * Where opening a scene moves the playhead: to its first frame, unless it is in the scene already,
 * where the reader keeps their place.
 */
export function openingSeek(
  scene: { readonly startMs: number; readonly durationMs: number },
  timeMs: number,
  fps: number
): number | undefined {
  const firstMs = chapterStart(scene, fps) * 1000
  if (timeMs >= firstMs && timeMs < scene.startMs + scene.durationMs) return undefined
  return firstMs
}

/**
 * Where each scene shows on the Scenes track, in play order: from where it starts, or where the
 * one before it ends when they cross, to where the next starts when they cross. What two scenes
 * play together is a crossfade of its own, after the first, so neither covers the other.
 */
export function sceneSpans(
  scenes: readonly { readonly startMs: number; readonly endMs: number }[]
): {
  readonly startMs: number
  readonly endMs: number
  /** What it plays together with the next scene. */
  readonly crossfade?: { readonly startMs: number; readonly endMs: number }
}[] {
  return scenes.map((scene, index) => {
    const before = scenes[index - 1]
    const after = scenes[index + 1]
    const startMs = before
      ? Math.min(Math.max(scene.startMs, before.endMs), scene.endMs)
      : scene.startMs
    const crossing = after && after.startMs < scene.endMs
    const endMs = crossing ? Math.max(startMs, after.startMs) : scene.endMs
    return crossing
      ? {
          startMs,
          endMs,
          crossfade: { startMs: endMs, endMs: Math.min(scene.endMs, after.endMs) },
        }
      : { startMs, endMs }
  })
}
