import type { ArtifactCommentAnchor } from "../storage/artifacts/types"
import type { VideoOutline, VideoOutlineScene } from "./outline"

// Where a comment on a video is, in the version read. A comment within a scene keeps how far into
// it its instant is, so it follows the scene when a later version trims or moves what comes before;
// one between two scenes, or past the last, keeps its instant from the video's start. Every reader
// places it from its anchor this way: the player, its panel and track, and the quote the Agent
// gets. Browser-safe.

/** Where a comment on a video is in one of its versions. */
export interface VideoCommentPlace {
  /**
   * Its instant in this version, in milliseconds from the video's start; none for a comment on a
   * whole scene or the whole video, or on a scene this version no longer has.
   */
  readonly ms?: number
  /** The scene it is about, as this version plays it. */
  readonly scene?: VideoOutlineScene
  /** The scene it is about is not in this version: its anchor's `label` still names it. */
  readonly gone?: true
}

/**
 * Where a comment on a video is in this version of it: its scene's start plus its offset, within
 * the scene's length; its own instant, within the video's, for one that plays no scene. The
 * outline is read as it is, never the composition, so placing every comment costs nothing.
 */
export function placeVideoComment(
  anchor: Pick<ArtifactCommentAnchor, "at" | "scene" | "offset">,
  outline: VideoOutline
): VideoCommentPlace {
  if (anchor.scene === undefined) {
    return anchor.at === undefined ? {} : { ms: Math.min(anchor.at, outline.durationMs) }
  }

  const scene = outline.scenes.find((each) => each.id === anchor.scene)
  if (!scene) return { gone: true }
  if (anchor.offset === undefined) return { scene }

  return { ms: scene.startMs + Math.min(anchor.offset, scene.durationMs), scene }
}

/**
 * The scene playing at an instant, in milliseconds: of those on screen then, the one that started
 * last, as where one fades into the next. None between two scenes, or past the last.
 */
export function videoSceneAt(outline: VideoOutline, ms: number): VideoOutlineScene | undefined {
  return outline.scenes
    .filter((scene) => scene.startMs <= ms && ms <= scene.startMs + scene.durationMs)
    .at(-1)
}
