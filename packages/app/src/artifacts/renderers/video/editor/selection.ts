import {
  VIDEO_ENTRY,
  type VideoClip,
  type VideoComposition,
  type VideoFileTimeline,
  type VideoScene,
} from "@sixb/core/artifacts/live"
import type { LiveVideoState } from "../../../live/video"
import { type LaidClip, layClips } from "./model"

// What the reader has selected in the editor, and what follows from it: the scene whose clips the
// timeline opens, and every clip laid out in the video's time.

/** A scene, or a clip of a file by its ref, as its file names it. */
export type EditorSelection =
  | { readonly type: "scene"; readonly scene: string }
  | { readonly type: "clip"; readonly file: string; readonly ref: string }
  | null

/** The scene a selection is in: the scene itself, or the scene whose file holds the clip. */
export function selectedScene(
  composition: VideoComposition,
  selection: EditorSelection
): VideoScene | undefined {
  if (!selection) return undefined
  if (selection.type === "scene")
    return composition.scenes.find((scene) => scene.id === selection.scene)
  return composition.scenes.find((scene) => scene.src === selection.file)
}

/** The clip a selection names, if it still is in its file. */
export function selectedClip(
  state: LiveVideoState,
  selection: EditorSelection
): VideoClip | undefined {
  if (selection?.type !== "clip") return undefined
  return state.timelines.get(selection.file)?.clips.find((clip) => clip.ref === selection.ref)
}

/**
 * The clips the timeline lays out: the open scene's, from its start, and the video's own, such as
 * its soundtrack, along its whole length.
 */
export function laidClips(
  state: LiveVideoState,
  composition: VideoComposition,
  open: VideoScene | undefined
): LaidClip[] {
  const own = state.timelines.get(VIDEO_ENTRY)
  const scene = open ? state.timelines.get(open.src) : undefined
  return [
    ...(scene && open
      ? layClips(scene, open.src, open.startMs, open.startMs + open.durationMs)
      : []),
    ...(own ? layClips(own, VIDEO_ENTRY, 0, composition.durationMs) : []),
  ]
}

/** Where a clip that writes no length ends, from its composition's start, for an edit to it. */
export function openEnd(composition: VideoComposition, file: string): number {
  if (file === VIDEO_ENTRY) return composition.durationMs
  return (
    composition.scenes.find((scene) => scene.src === file)?.durationMs ?? composition.durationMs
  )
}

/** What a clip is called: its words, its file's name, or its id. */
export function clipName(clip: VideoClip): string {
  if (clip.text) return clip.text
  if (clip.src) return clip.src.replace(/^.*\//, "")
  return clip.id ?? clip.tag
}

/** A scene's name, as its chapter shows it: its label, else its id. */
export function sceneName(scene: VideoScene): string {
  return scene.label ?? scene.id
}

/** The first recording a scene shows, which its thumbnail falls back on. */
export function sceneFootage(timeline: VideoFileTimeline | undefined): VideoClip | undefined {
  return timeline?.clips.find((clip) => clip.kind === "video" && clip.src)
}
