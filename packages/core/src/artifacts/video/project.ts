import type { VideoComposition, VideoScene, VideoSourceSpan } from "./composition"

// A segment of a video's export renders from a project of its own: the version's `index.html`
// keeping only the scenes on screen during the segment, each started at a number of seconds and
// moved as early as the segment allows, and the root lasting until the segment ends. HyperFrames
// then renders those frames alone, from frame 0 when it can, which is its fast path. Browser-safe:
// text in, text out. See README.md beside this file.

/** How HyperFrames renders one segment of a video's export. */
export interface VideoSegmentRender {
  /** The scenes it keeps: those on screen with the segment's scene, in `index.html`'s order. */
  readonly scenes: readonly string[]
  /** The whole frames everything is moved earlier by. */
  readonly shiftFrames: number
  /** The frames it renders, once moved: from `from`, up to `to`, which the root then lasts. */
  readonly from: number
  readonly to: number
}

/**
 * How the segment of `scene` from `startFrame` up to `endFrame` renders. Every scene on screen
 * during it is on screen with `scene`, so the project keeps those alone. It is moved earlier by as
 * many whole frames as no kept scene starts before, so a scene keeps its place between frames, up
 * to the segment's start: then HyperFrames renders it from frame 0. A scene still on screen from
 * before the segment, or a root that moves on its own, keeps it from there: HyperFrames then
 * renders a range of the project, from `from`.
 */
export function videoSegmentRender(
  composition: Pick<VideoComposition, "fps" | "scenes">,
  segment: { readonly scene: string; readonly startFrame: number; readonly endFrame: number },
  rootMoves: boolean
): VideoSegmentRender {
  const { fps } = composition
  const scene = composition.scenes.find((each) => each.id === segment.scene)
  if (!scene) throw new Error(`[Sixb] The video has no scene '${segment.scene}' to render.`)

  const kept = composition.scenes.filter((other) => playTogether(scene, other))
  const earliest = Math.min(...kept.map((each) => frameAtOrBefore(each.startMs, fps)))
  const shiftFrames = rootMoves ? 0 : Math.min(segment.startFrame, earliest)

  return {
    scenes: kept.sort((a, b) => a.host.element.start - b.host.element.start).map((each) => each.id),
    shiftFrames,
    from: segment.startFrame - shiftFrames,
    to: segment.endFrame - shiftFrames,
  }
}

/**
 * `index.html` as `render` keeps it: only its scenes' hosts, each starting at a number of seconds,
 * `shiftFrames` earlier, and the root lasting `to` frames. What else the root holds stays as
 * written, its soundtrack too, which HyperFrames mixes and the segment drops.
 */
export function videoSegmentIndex(
  index: string,
  composition: Pick<VideoComposition, "fps" | "scenes" | "root">,
  render: Pick<VideoSegmentRender, "scenes" | "shiftFrames" | "to">
): string {
  const { fps, root } = composition
  const kept = new Set(render.scenes)
  const shiftSeconds = render.shiftFrames / fps

  const edits: Edit[] = composition.scenes.flatMap((scene): Edit[] => {
    if (!kept.has(scene.id)) return [{ ...scene.host.element, with: "" }]

    const start = scene.host.attributes["data-start"] as VideoSourceSpan
    const seconds = seconds6(scene.startMs / 1000 - shiftSeconds)
    return [{ ...start, with: `data-start="${seconds}"` }]
  })

  const length = `data-duration="${seconds6(render.to / fps)}"`
  const duration = root.attributes["data-duration"]
  // A start tag ends in `>`: the length goes right before it.
  const before = root.tag.end - 1
  edits.push(
    duration ? { ...duration, with: length } : { start: before, end: before, with: ` ${length}` }
  )

  return applyEdits(index, edits)
}

/** The frame a moment falls on, or the last one before it. */
export function frameAtOrBefore(ms: number, fps: number): number {
  return Math.floor((ms * fps) / 1000 + 1e-6)
}

/**
 * How many frames HyperFrames renders of `ms`: the nearest whole frame when it is within a
 * thousandth of one, the next one otherwise, as its `durationToFrameCount` counts.
 */
export function videoFrameCount(ms: number, fps: number): number {
  const exact = (ms * fps) / 1000
  const nearest = Math.round(exact)
  return Math.abs(exact - nearest) <= 1e-3 ? nearest : Math.ceil(exact)
}

/** Whether two scenes are on screen at once, for a moment at least. */
export function playTogether(
  a: Pick<VideoScene, "startMs" | "durationMs">,
  b: Pick<VideoScene, "startMs" | "durationMs">
): boolean {
  return a.startMs < b.startMs + b.durationMs && b.startMs < a.startMs + a.durationMs
}

/** Seconds as HyperFrames reads them: at most six decimals, never negative, never `1e-7`. */
function seconds6(seconds: number): string {
  return String(Math.max(0, Number(seconds.toFixed(6))))
}

type Edit = VideoSourceSpan & { readonly with: string }

/** The text with each span replaced by its `with`; the spans do not overlap. */
function applyEdits(text: string, edits: readonly Edit[]): string {
  let out = ""
  let kept = 0
  for (const edit of [...edits].sort((a, b) => a.start - b.start || a.end - b.end)) {
    out += text.slice(kept, edit.start) + edit.with
    kept = edit.end
  }
  return out + text.slice(kept)
}
