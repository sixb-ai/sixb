import {
  findVideoTarget,
  VIDEO_ENTRY,
  type VideoClip,
  type VideoComposition,
  type VideoFileTimeline,
  type VideoScene,
  type VideoTarget,
  type VideoText,
  videoChains,
  videoTarget,
} from "@sixb/core/artifacts/live"
import type { LiveVideoState } from "../../../live/video"
import { clipKey, type LaidClip, layClips, onRows } from "./model"

// What the reader has selected in the editor, and what follows from it: every clip laid out in the
// video's time, as the timeline shows them, and the chapter the Transcript tab reads.

/**
 * A scene, or a clip of a file by its target: its id, else its place with what it held, so a
 * selection follows its clip when someone else's edit shifts the places, and lets go once it is gone.
 * Several clips, from any scene and the video's own, are each named the same way.
 */
export type EditorSelection =
  | { readonly type: "scene"; readonly scene: string }
  | { readonly type: "clip"; readonly file: string; readonly target: VideoTarget }
  | { readonly type: "clips"; readonly clips: readonly ClipChoice[] }
  | null

/** A clip of a file a selection names. */
export interface ClipChoice {
  readonly file: string
  readonly target: VideoTarget
}

/** The chapter a selection names, when it is one. */
export function selectedScene(
  composition: VideoComposition,
  selection: EditorSelection
): VideoScene | undefined {
  if (selection?.type !== "scene") return undefined
  return composition.scenes.find((scene) => scene.id === selection.scene)
}

/** The clips a selection names: none for a scene, one, or several. */
export function choices(selection: EditorSelection): readonly ClipChoice[] {
  if (selection?.type === "clip") return [{ file: selection.file, target: selection.target }]
  if (selection?.type === "clips") return selection.clips
  return []
}

/** The selection of these clips, as the editor reads them now: none, the one, or all of them. */
export function choose(
  clips: readonly { readonly file: string; readonly clip: VideoClip }[]
): EditorSelection {
  return selectionOf(clips.map((each) => ({ file: each.file, target: videoTarget(each.clip) })))
}

/** The selection of the clips these name: none, the one, or all of them. */
export function selectionOf(clips: readonly ClipChoice[]): EditorSelection {
  const [only] = clips
  if (!only) return null
  return clips.length === 1 ? { type: "clip", ...only } : { type: "clips", clips }
}

/**
 * The clips laid out on the timeline that a selection names, as their files are now: one gone, or
 * no longer alone like it, is let go.
 */
export function chosenIn<T extends { readonly file: string; readonly clip: VideoClip }>(
  clips: readonly T[],
  selection: EditorSelection
): T[] {
  const chosen = new Set<T>()
  for (const choice of choices(selection)) {
    const inFile = clips.filter((each) => each.file === choice.file)
    const found = findVideoTarget(
      inFile.map((each) => each.clip),
      choice.target
    )
    const laid = Array.isArray(found) ? undefined : inFile.find((each) => each.clip === found)
    if (laid) chosen.add(laid)
  }
  return [...chosen]
}

/**
 * The selection once `laid` is added to the clips chosen, or taken out when it is one of them, as
 * a click with the command key does.
 */
export function toggled<T extends { readonly file: string; readonly clip: VideoClip }>(
  clips: readonly T[],
  selection: EditorSelection,
  laid: T
): EditorSelection {
  const chosen = chosenIn(clips, selection)
  const same = (each: T) => each.file === laid.file && each.clip.ref === laid.clip.ref
  return choose(chosen.some(same) ? chosen.filter((each) => !same(each)) : [...chosen, laid])
}

/** Every clip a selection names that is still in its file, each in its file. */
export function selectedClips(
  state: LiveVideoState,
  selection: EditorSelection
): { readonly file: string; readonly clip: VideoClip }[] {
  const files = new Set(choices(selection).map((choice) => choice.file))
  const clips = [...files].flatMap((file) =>
    (state.timelines.get(file)?.clips ?? []).map((clip) => ({ file, clip }))
  )
  return chosenIn(clips, selection)
}

/**
 * The open chapter's clips, from its start, and the video's own, such as its soundtrack, along its
 * whole length: what the Transcript tab reads.
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
 * Every scene's clips, laid in the video, and the video's own: what the timeline shows. Scenes that
 * play together, as in a crossfade, share the rows, so their clips lie apart.
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

  return [
    ...inChains(onRows(scenes), composition, state),
    ...(own ? layClips(own, VIDEO_ENTRY, 0, composition.durationMs) : []),
  ]
}

/**
 * Laid clips, each part of a clip that goes on in later scenes knowing that clip, as the core
 * reads it (`videoChains`), and whether the part before or after it lies against it on its row.
 */
function inChains(
  clips: readonly LaidClip[],
  composition: VideoComposition,
  state: LiveVideoState
): LaidClip[] {
  const chains = videoChains(composition.scenes, (file) => state.timelines.get(file))
  if (chains.length === 0) return [...clips]

  const byKey = new Map(clips.map((laid) => [clipKey(laid), laid]))
  const chained = new Map<string, NonNullable<LaidClip["chain"]>>()
  for (const chain of chains) {
    const parts = chain.parts.map((part) => byKey.get(clipKey(part)))
    const key = chain.parts[0] ? clipKey(chain.parts[0]) : ""
    parts.forEach((laid, index) => {
      if (!laid) return
      const touches = (other: LaidClip | undefined, before: boolean) =>
        other !== undefined &&
        other.row === laid.row &&
        Math.abs(before ? other.endMs - laid.startMs : laid.endMs - other.startMs) <= 1
      chained.set(clipKey(laid), {
        key,
        first: index === 0,
        last: index === parts.length - 1,
        joinsBefore: touches(parts[index - 1], true),
        joinsAfter: touches(parts[index + 1], false),
      })
    })
  }
  return clips.map((laid) => {
    const chain = chained.get(clipKey(laid))
    return chain ? { ...laid, chain } : laid
  })
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
