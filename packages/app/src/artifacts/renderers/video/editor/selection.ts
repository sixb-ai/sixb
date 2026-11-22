import {
  findVideoTarget,
  VIDEO_ENTRY,
  type VideoClip,
  type VideoComposition,
  type VideoFileTimeline,
  type VideoScene,
  type VideoTarget,
  type VideoText,
} from "@sixb/core/artifacts/live"
import type { LiveVideoState } from "../../../live/video"
import { type LaidClip, layClips, onRows } from "./model"

// What the reader has selected in the editor, and what follows from it: the scene whose clips the
// timeline opens, and every clip laid out in the video's time.

/**
 * A scene, or a clip of a file by its target: its id, else its place with what it held, so a
 * selection follows its clip when someone else's edit shifts the places, and lets go once it is gone.
 */
export type EditorSelection =
  | { readonly type: "scene"; readonly scene: string }
  | { readonly type: "clip"; readonly file: string; readonly target: VideoTarget }
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
  const found = findVideoTarget(state.timelines.get(selection.file)?.clips ?? [], selection.target)
  return Array.isArray(found) ? undefined : (found as VideoClip)
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

/**
 * Every scene's clips, laid in the video, and the video's own: the timeline when it shows all the
 * scenes. Scenes that play together, as in a crossfade, share the rows, so their clips lie apart.
 */
export function everySceneClips(state: LiveVideoState, composition: VideoComposition): LaidClip[] {
  const own = state.timelines.get(VIDEO_ENTRY)
  const scenes = [...composition.scenes]
    .sort((a, b) => a.startMs - b.startMs)
    .flatMap((scene) => {
      const timeline = state.timelines.get(scene.src)
      return timeline
        ? layClips(timeline, scene.src, scene.startMs, scene.startMs + scene.durationMs)
        : []
    })

  return [...onRows(scenes), ...(own ? layClips(own, VIDEO_ENTRY, 0, composition.durationMs) : [])]
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

/**
 * The words of a clip an editor may type over: the clip itself, when it holds text alone. A caption
 * that styles its words has none, since typing over them would drop the styling.
 */
export function typedText(
  timeline: VideoFileTimeline | undefined,
  clip: VideoClip
): VideoText | undefined {
  return timeline?.texts.find((text) => text.source.element.start === clip.source.element.start)
}

/** The first recording a scene shows, which its thumbnail falls back on. */
export function sceneFootage(timeline: VideoFileTimeline | undefined): VideoClip | undefined {
  return timeline?.clips.find((clip) => clip.kind === "video" && clip.src)
}

/** A recording the Transcript tab can show: the file whose clips play it, and those clips. */
export interface SpokenRecording {
  readonly src: string
  /** The open scene's file, or `index.html` for the video's own, such as a voice-over. */
  readonly file: string
  readonly clips: readonly LaidClip[]
}

/**
 * The recordings heard in the open scene, the sounds and the footage not muted, as the Transcript
 * tab offers them: the scene's own before the video's, and in each, the one under the playhead
 * first, then the one heard longest in the scene, then the longest.
 */
export function heardRecordings(
  clips: readonly LaidClip[],
  open: VideoScene | undefined,
  timeMs: number
): SpokenRecording[] {
  const byRecording = new Map<string, SpokenRecording>()
  for (const laid of clips) {
    const { kind, src, silent } = laid.clip
    if (!src || silent || (kind !== "video" && kind !== "audio")) continue

    const key = `${laid.file}\n${src}`
    const found = byRecording.get(key)
    byRecording.set(key, {
      src,
      file: laid.file,
      clips: [...(found?.clips ?? []), laid],
    })
  }

  const sceneStart = open?.startMs ?? 0
  const sceneEnd = open ? open.startMs + open.durationMs : Number.POSITIVE_INFINITY
  const rank = (recording: SpokenRecording) => ({
    own: recording.file === VIDEO_ENTRY ? 0 : 1,
    under: recording.clips.some((laid) => laid.startMs <= timeMs && timeMs < laid.endMs) ? 1 : 0,
    inScene: sum(recording.clips, (laid) =>
      Math.max(0, Math.min(laid.endMs, sceneEnd) - Math.max(laid.startMs, sceneStart))
    ),
    length: sum(recording.clips, (laid) => laid.endMs - laid.startMs),
  })

  return [...byRecording.values()]
    .map((recording) => ({ recording, rank: rank(recording) }))
    .sort(
      (a, b) =>
        b.rank.own - a.rank.own ||
        b.rank.under - a.rank.under ||
        b.rank.inScene - a.rank.inScene ||
        b.rank.length - a.rank.length
    )
    .map(({ recording }) => recording)
}

function sum<T>(items: readonly T[], of: (item: T) => number): number {
  return items.reduce((total, item) => total + of(item), 0)
}
