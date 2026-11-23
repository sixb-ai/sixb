import { ARTIFACT_LIMITS } from "../limits"
import { diffSequences, diffText, textLines } from "../live/diff"
import {
  parseVideoRoot,
  readVideoComposition,
  VIDEO_ENTRY,
  type VideoRoot,
  type VideoSourceSpan,
  type VideoStart,
  videoFilePath,
  videoFilesPlayed,
} from "./composition"
import {
  type CssBlock,
  cssBlocks,
  keyframesOf,
  LOOK_ID,
  type Look,
  type LookContext,
  type LookElement,
  type LookSheet,
  lookDiffers,
  lookKey,
  lookOf,
  type SceneKeyframes,
  scriptNames,
  scriptReaches,
  scriptReachesIn,
  writtenLook,
} from "./looks"
import {
  goesOnFrom,
  readRootLayers,
  readRootTimeline,
  readSceneTimeline,
  sceneAfter,
  type VideoChain,
  type VideoChainPart,
  type VideoClip,
  type VideoElementSource,
  type VideoFileTimeline,
  type VideoText,
  type VideoTrack,
  videoChains,
} from "./timeline"

// What an editor does to a video, as the smallest changes to the text of its files: a scene made
// longer is one `data-duration` written again, a clip split is one attribute and one element
// added. Each operation changes a working copy of the files step by step, reading them again
// between steps, checks that the result is still a video or refuses it, and returns what changed
// as the live layer's diff finds it: each changed run of lines narrowed to its attributes and
// words. So two people editing at once change different text, which the live document merges, and
// the Agent's next diff reads as an edit, not a rewrite. Browser-safe, as `composition.ts`. See
// README.md.

/**
 * A change to a file's text: `remove` characters at `index`, then `insert` there, as the live
 * layer's `BoardChange`. A file's changes are sorted and apart, each at its place in the text
 * before the edit, so `applyBoardEditToText` applies them.
 */
export interface VideoTextChange {
  readonly index: number
  readonly remove: number
  readonly insert: string
}

/** What an edit does to one file: changes its text, creates it, or removes it. */
export type VideoFileEdit =
  | { readonly path: string; readonly changes: readonly VideoTextChange[] }
  | { readonly path: string; readonly create: string }
  | { readonly path: string; readonly remove: true }

export type VideoEdit = readonly VideoFileEdit[]

/** A video's files as an editor holds them: each HTML file's text, null for a media file. */
export type VideoSources = ReadonlyMap<string, string | null>

/** An edit, or why it is refused: the video it would leave is not one. */
export type VideoEditResult =
  | { readonly edit: VideoEdit }
  | {
      readonly error: string
      /** Why, for an editor to say in its reader's words: a file grown past what publishing reads. */
      readonly refusal?: "too_large"
    }

/** A stretch of time, in milliseconds, its end not included. */
export interface VideoRange {
  readonly startMs: number
  readonly endMs: number
}

/**
 * A stretch to cut, and the `room` around it the cut may take as it grows to whole frames without
 * touching anything kept: for a transcript's words, the pauses up to the words either side.
 * Without one, the cut grows as much on each side.
 */
export interface VideoCut extends VideoRange {
  readonly room?: VideoRange
}

/** The loudest a clip's sound is made, `data-volume`, as many times as loud as recorded. */
export const MAX_VOLUME = 4

/** The shortest a scene or a clip may become: a few frames. */
export const MIN_CLIP_MS = 100

/** Within this, two instants are one: under a frame at 60 fps. */
const SAME_MS = 15

/**
 * How an edit names an element of a file: its ref, or its ref with what the editor read there.
 * An element without an id is named by its place, which someone else's edit may shift between
 * the reader's choice and the edit: with what it held, the edit still finds it, or refuses.
 * {@link videoTarget} makes one.
 */
export type VideoTarget =
  | string
  | {
      readonly ref: string
      readonly tag: string
      /** Its words, as a text or a caption holds them. */
      readonly words?: string
      /** The file it plays or shows. */
      readonly src?: string
    }

/** The target that names a clip or a text as the editor reads it now. */
export function videoTarget(element: VideoClip | VideoText): VideoTarget {
  if ("id" in element && element.id) return element.ref
  return {
    ref: element.ref,
    tag: element.tag,
    ...(element.text === undefined ? {} : { words: element.text }),
    ...("src" in element && element.src ? { src: element.src } : {}),
  }
}

/** The clips an editor can import. */
export type VideoImportKind = "video" | "audio" | "image"

// Scenes ------------------------------------------------------------------------------------------

/**
 * Makes a scene about `ms` long, as long as {@link videoSceneLength} says. The scenes after it
 * move with its end: those chained to it as HyperFrames moves them, and those at a number of
 * seconds by as much. The video's own length, and a soundtrack that ran to its end, follow.
 */
export function setSceneLength(sources: VideoSources, scene: string, ms: number): VideoEditResult {
  return run(sources, (work) => {
    if (!(ms >= MIN_CLIP_MS)) throw new EditError(`A scene lasts at least ${MIN_CLIP_MS} ms.`)
    lengthenScene(work, scene, videoSceneLength(ms, rootOf(work).fps))
  })
}

/**
 * The length {@link setSceneLength} gives a scene asked to last `ms` in a video at `fps`: the
 * nearest whole number of frame steps, 100 ms at 30 fps, so the scenes after move by whole frames.
 * A field shows it as soon as it is typed.
 */
export function videoSceneLength(ms: number, fps: number): number {
  const step = frameStepMs(fps)
  return Math.max(Math.ceil(MIN_CLIP_MS / step), Math.round(ms / step)) * step
}

/** Names a scene, as its chapter shows it; an empty label removes it. */
export function setSceneLabel(
  sources: VideoSources,
  scene: string,
  label: string
): VideoEditResult {
  return run(sources, (work) => {
    const named = label.replace(/\s+/g, " ").trim().slice(0, ARTIFACT_LIMITS.maxTitleLength)
    const host = hostOf(work, scene)
    setAttributes(work, VIDEO_ENTRY, host.host, { "data-label": named === "" ? null : named })
  })
}

/**
 * Moves a scene to `to` in play order: each scene that follows another than before starts when
 * that one ends, keeping its own overlap or gap. Hosts keep their lines in `index.html`, so a move
 * is attribute values written again, which merge with someone else's edit of the same host. Scenes
 * on screen together then stack in play order, the later on top (`restack`).
 */
export function moveScene(sources: VideoSources, scene: string, to: number): VideoEditResult {
  return run(sources, (work) => {
    const before = openRoot(work)
    const order = [...before.scenes]
    const from = order.findIndex((each) => each.id === scene)
    if (from < 0) throw new EditError(noScene(scene))

    const target = Math.min(Math.max(Math.round(to), 0), order.length - 1)
    if (target === from) return

    const [moved] = order.splice(from, 1)
    if (!moved) return
    order.splice(target, 0, moved)

    // Each scene whose predecessor changed starts after its new one, and so, from there on, does
    // each that starts at a number of seconds: its predecessor's place changed.
    const was = new Map(before.scenes.map((each, index) => [each.id, before.scenes[index - 1]?.id]))
    const changed = order.findIndex((each, index) => was.get(each.id) !== order[index - 1]?.id)
    order.forEach((each, index) => {
      const after = order[index - 1]
      const kept = was.get(each.id) === after?.id
      if (kept && (index < changed || each.start.type === "after")) return

      const start = after ? chainedStart(after.id, gapBefore(before.scenes, each)) : "0"
      setAttributes(work, VIDEO_ENTRY, hostOf(work, each.id).host, { "data-start": start })
    })

    restack(work)
  })
}

/**
 * Copies a scene: its file under a new id, its host after its own, and the scenes that followed it
 * now following the copy. Every element of the copy gets an id of its own, as HyperFrames plays
 * each recording by its id and a clip is one clip by its id, and none of it goes on from a clip of
 * the original's. Returns the copy's id with the edit.
 */
export function duplicateScene(
  sources: VideoSources,
  scene: string
): VideoEditResult & { readonly scene?: string } {
  let copy: string | undefined
  const result = run(sources, (work) => {
    const chains = chainsOf(work)
    const before = openRoot(work)
    const original = hostOf(work, scene)
    const taken = takenNames(work)
    const id = uniqueName(scene, taken)
    copy = id
    taken.add(id)

    const folder = original.src.includes("/")
      ? original.src.slice(0, original.src.lastIndexOf("/") + 1)
      : ""
    const src = uniquePath(work, `${folder}${id}`, ".html")
    work.create(src, copySceneFile(work.text(original.src), scene, id, taken))

    // The copy's host is its original's, renamed, starting when the original ends.
    const index = work.text(VIDEO_ENTRY)
    const block = lineBlock(index, original.host.element)
    const host = withAttributes(
      index.slice(original.host.element.start, original.host.element.end),
      {
        "data-composition-id": id,
        "data-composition-src": src,
        "data-start": scene,
        ...(original.host.attributes.id ? { id } : {}),
      }
    )
    const indent = index.slice(block.start, original.host.element.start)
    work.replace(VIDEO_ENTRY, block.end, block.end, `${indent}${host}${lineEnd(index, block)}`)

    // What followed the original follows the copy; a scene after it at a number of seconds
    // starts as much later as the copy lasts.
    const place = before.scenes.findIndex((each) => each.id === scene)
    const length = before.scenes[place]?.durationMs ?? 0
    before.scenes.forEach((each, index) => {
      if (index <= place) return

      if (startsAfter(each.start, original)) {
        const offset = each.start.type === "after" ? each.start.offset : 0
        setAttributes(work, VIDEO_ENTRY, hostOf(work, each.id).host, {
          "data-start": chainedStart(id, offset),
        })
      } else if (each.start.type === "at") {
        setAttributes(work, VIDEO_ENTRY, hostOf(work, each.id).host, {
          "data-start": seconds(each.startMs + length),
        })
      }
    })
    strandedParts(work, chains)
  })
  return "edit" in result && copy ? { ...result, scene: copy } : result
}

/**
 * Removes a scene: its host, and its file unless another scene plays it. The scenes that followed
 * it start where it started, keeping their own overlap or gap, and the video is shorter by as
 * much.
 */
export function removeScene(sources: VideoSources, scene: string): VideoEditResult {
  return run(sources, (work) => {
    const chains = chainsOf(work)
    openRoot(work)
    dropScene(work, scene)
    strandedParts(work, chains)
  })
}

/**
 * Lets go of the parts a scene copied or removed leaves out of the clip they went on from, as a
 * copy coming between two of its scenes does: each loses `data-continues`, so no later
 * placement links it again across what came between, and it is a clip of its own.
 */
function strandedParts(work: Working, before: ReadonlyMap<string, VideoChain>): void {
  const after = new Set([...chainsOf(work).keys()])
  for (const [key, chain] of before) {
    const [file] = key.split("\n")
    const part = chain.parts.find((each) => `${each.file}\n${each.clip.ref}` === key)
    if (!file || !part || part === chain.parts[0] || after.has(key)) continue
    if (work.textOf(file) === undefined || !part.clip.id) continue

    const now = readTimeline(work, file)?.clips.find((clip) => clip.id === part.clip.id)
    if (now?.continues) setAttributes(work, file, now.source, { "data-continues": null })
  }
}

// Clips -------------------------------------------------------------------------------------------

/**
 * Sets a clip's timing, in milliseconds from its composition's start and into its file, as an
 * inspector's fields do: nothing around it moves.
 */
export function setClipTiming(
  sources: VideoSources,
  file: string,
  clip: VideoTarget,
  timing: {
    readonly startMs?: number
    readonly durationMs?: number
    readonly mediaStartMs?: number
  }
): VideoEditResult {
  return run(sources, (work) => {
    const found = clipOf(work, file, clip)
    const { startMs, durationMs, mediaStartMs } = timing
    if (startMs !== undefined && !(startMs >= 0))
      throw new EditError("A clip starts at 0 or later.")
    if (durationMs !== undefined && !(durationMs >= MIN_CLIP_MS)) {
      throw new EditError(`A clip lasts at least ${MIN_CLIP_MS} ms.`)
    }
    if (mediaStartMs !== undefined && !(mediaStartMs >= 0)) {
      throw new EditError("A clip plays its file from 0 or later.")
    }

    // A clip that goes on in later scenes plays its file on from as far further in each.
    const chain = chainsOf(work).get(`${file}\n${found.ref}`)
    if (mediaStartMs !== undefined && playsFile(found) && chain) {
      const by = mediaStartMs - found.mediaStartMs
      if (chain.parts.some((part) => part.clip.mediaStartMs + by < 0)) {
        throw new EditError("A clip plays its file from 0 or later.")
      }
      for (const part of chain.parts) {
        if (part.file === file) continue
        setAttributes(work, part.file, clipOf(work, part.file, part.clip.ref).source, {
          "data-media-start": seconds(part.clip.mediaStartMs + by),
        })
      }
    }

    setAttributes(work, file, clipOf(work, file, found.ref).source, {
      ...(startMs === undefined ? {} : { "data-start": seconds(startMs) }),
      ...(durationMs === undefined ? {} : { "data-duration": seconds(durationMs) }),
      ...(mediaStartMs === undefined || !playsFile(found)
        ? {}
        : { "data-media-start": seconds(mediaStartMs) }),
    })
  })
}

/**
 * Moves a clip's edge to `toMs`, from its composition's start. Its end makes it shorter or longer;
 * its start, into its file as much, as dragging a clip's edge does. An end pulled past its scene's
 * end goes on in the next scene, as {@link moveClips} places a clip, or the last scene grows to
 * hold it. A start never goes before its scene's. With `ripple`, what comes after the edge moves
 * with it, the scene's end included, so the clip stays whole in its scene, and a start keeps its
 * place: the clip pulls the rest of the scene in.
 */
export function trimClip(
  sources: VideoSources,
  file: string,
  clip: VideoTarget,
  edge: "start" | "end",
  toMs: number,
  options: { readonly ripple?: boolean; readonly endMs?: number } = {}
): VideoPlaceResult {
  return placing(sources, (work) => {
    const found = clipOf(work, file, clip)
    const end = clipEnd(found, options.endMs)
    // Where the file's composition starts in the video: `toMs` is from there.
    const offsetMs = videoStartOf(work, file, found) - found.startMs
    const chains = file === VIDEO_ENTRY ? new Map<string, VideoChain>() : chainsOf(work)
    const logical = logicalClip(work, chains, { file, clip: found })

    if (edge === "end") {
      if (options.ripple || file === VIDEO_ENTRY) {
        const length = Math.round(toMs) - found.startMs
        if (length < MIN_CLIP_MS) throw new EditError(`A clip lasts at least ${MIN_CLIP_MS} ms.`)
        if (length === found.durationMs) return undefined

        setAttributes(work, file, found.source, { "data-duration": seconds(length) })
        if (options.ripple)
          ripple(work, file, end, found.startMs + length - end, new Set([found.ref]))
        return undefined
      }

      // The clip as one, whichever part's end is pulled: it ends there in the video.
      const length = offsetMs + Math.round(toMs) - logical.startMs
      if (length < MIN_CLIP_MS) throw new EditError(`A clip lasts at least ${MIN_CLIP_MS} ms.`)
      // As long as its scenes show it already: nothing changes.
      if (length === logical.durationMs) return undefined
      return placeFound(work, [{ ...logical, durationMs: length }])
    }

    // A clip that goes on in later scenes starts later or sooner as one, and is placed again:
    // never before its file's start, nor its first scene's.
    if ((logical.others?.length ?? 0) > 0 && !options.ripple) {
      const head = sceneOf(work, logical.file)
      const into = logical.clip.mediaStartMs
      const floor = Math.max(
        head?.startMs ?? 0,
        playsFile(logical.clip) ? logical.startMs - into : (head?.startMs ?? 0)
      )
      const startMs = Math.max(offsetMs + Math.round(toMs), floor)
      const endMs = logical.startMs + (logical.durationMs ?? 0)
      if (endMs - startMs < MIN_CLIP_MS) {
        throw new EditError(`A clip lasts at least ${MIN_CLIP_MS} ms.`)
      }
      if (startMs === logical.startMs) return undefined
      return placeFound(work, [
        {
          ...logical,
          startMs,
          durationMs: endMs - startMs,
          ...jumpsFrom(into, logical.jumps, startMs - logical.startMs),
        },
      ])
    }

    // How far its start moves into its file, or back out of it: never before its file's start,
    // nor, unless it ripples and keeps its place, before its composition's.
    const floors = [playsFile(found) ? -found.mediaStartMs : -found.startMs]
    if (!options.ripple) floors.push(-found.startMs)
    const moved = Math.max(Math.round(toMs) - found.startMs, ...floors)
    if (end - (found.startMs + moved) < MIN_CLIP_MS) {
      throw new EditError(`A clip lasts at least ${MIN_CLIP_MS} ms.`)
    }

    setAttributes(work, file, found.source, {
      ...(options.ripple ? {} : { "data-start": seconds(found.startMs + moved) }),
      "data-duration": seconds(end - found.startMs - moved),
      ...(playsFile(found) ? { "data-media-start": seconds(found.mediaStartMs + moved) } : {}),
    })
    if (options.ripple) ripple(work, file, end, -moved, new Set([found.ref]))
    return undefined
  })
}

/**
 * Moves a clip to start at `startMs` from its composition's start, its length kept, never before
 * the video's: before its scene's start, it goes into the scene it then plays in, as
 * {@link moveClips} places several.
 */
export function moveClip(
  sources: VideoSources,
  file: string,
  clip: VideoTarget,
  startMs: number
): VideoPlaceResult {
  return placing(sources, (work) => {
    const found = clipOf(work, file, clip)
    return moveFound(work, [{ file, clip: found }], Math.round(startMs) - found.startMs)
  })
}

/** Sets how loud a clip plays, from 0 to 1, and how long it fades in and out, in milliseconds. */
export function setClipSound(
  sources: VideoSources,
  file: string,
  clip: VideoTarget,
  sound: {
    readonly volume?: number
    readonly fadeInMs?: number
    readonly fadeOutMs?: number
    /** Footage whose sound is not played, or played again. */
    readonly muted?: boolean
  }
): VideoEditResult {
  return run(sources, (work) => {
    const found = clipOf(work, file, clip)
    if (found.kind !== "video" && found.kind !== "audio") {
      throw new EditError(`'${found.ref}' plays no sound.`)
    }
    if (sound.muted !== undefined && found.kind !== "video") {
      throw new EditError(`'${found.ref}' is a sound: turn its volume down instead.`)
    }

    // As loud as 4 times as recorded, or as loud as it already is.
    const { volume, fadeInMs, fadeOutMs } = sound
    const loudest = Math.max(MAX_VOLUME, found.volume ?? 1)
    if (volume !== undefined && !(volume >= 0 && volume <= loudest)) {
      throw new EditError(`A clip's volume is from 0 to ${loudest}.`)
    }
    for (const fade of [fadeInMs, fadeOutMs]) {
      if (fade !== undefined && !(fade >= 0)) throw new EditError("A fade lasts 0 s or more.")
    }

    // A clip that goes on in later scenes sounds as one: as loud in each part, fading in on the
    // first and out on the last.
    const parts = chainsOf(work).get(`${file}\n${found.ref}`)?.parts ?? [
      { file, clip: found, startMs: 0, endMs: 0 },
    ]
    parts.forEach((part, index) => {
      setAttributes(work, part.file, clipOf(work, part.file, part.clip.ref).source, {
        ...(volume === undefined ? {} : { "data-volume": String(Math.round(volume * 100) / 100) }),
        ...(fadeInMs === undefined || index > 0
          ? {}
          : { "data-fade-in": fadeInMs === 0 ? null : seconds(fadeInMs) }),
        ...(fadeOutMs === undefined || index < parts.length - 1
          ? {}
          : { "data-fade-out": fadeOutMs === 0 ? null : seconds(fadeOutMs) }),
        // Muted, as HyperFrames mixes no sound of it; heard, its sound mixed in again.
        ...(sound.muted === undefined
          ? {}
          : sound.muted
            ? { muted: "", "data-has-audio": null }
            : { muted: null, "data-has-audio": "true" }),
      })
    })
  })
}

/**
 * Types over the words of an element that holds text alone, by its ref among the file's texts.
 * A line break in `text` is a `<br>`.
 */
export function setVideoText(
  sources: VideoSources,
  file: string,
  ref: VideoTarget,
  text: string
): VideoEditResult {
  return run(sources, (work) => {
    const found = resolveTarget(timelineOf(work, file).texts, ref, file, "text")
    if (!found.source.content) throw new EditError(`${file} shows no text '${found.ref}'.`)

    const words = text.trim()
    if (words === "") throw new EditError("A text says something: remove it instead.")

    const html = words
      .split(/\r?\n/)
      .map((line) => escapeText(line.trim()))
      .join("<br>")

    // A caption that goes on in later scenes says the same in each.
    const clip = timelineOf(work, file).clips.find(
      (each) => each.source.element.start === found.source.element.start
    )
    const chain = clip ? chainsOf(work).get(`${file}\n${clip.ref}`) : undefined
    for (const part of chain?.parts ?? []) {
      if (part.file === file) continue
      const text = timelineOf(work, part.file).texts.find(
        (each) => each.source.element.start === part.clip.source.element.start
      )
      if (text?.source.content) {
        work.replace(part.file, text.source.content.start, text.source.content.end, html)
      }
    }
    work.replace(file, found.source.content.start, found.source.content.end, html)
  })
}

/**
 * Splits a clip at `atMs` from its composition's start into two, the second a copy that starts
 * there and plays on from where the first stops. `endMs` is where a clip that writes no length
 * ends, as its file or its scene ends it.
 */
export function splitClip(
  sources: VideoSources,
  file: string,
  clip: VideoTarget,
  atMs: number,
  options: { readonly endMs?: number } = {}
): VideoEditResult & { readonly clip?: string } {
  let second: string | undefined
  const result = run(sources, (work) => {
    const chains = chainsOf(work)
    second = splitChained(work, chains, file, clipOf(work, file, clip), atMs, options.endMs)
  })
  return "edit" in result && second ? { ...result, clip: second } : result
}

/**
 * Removes a clip. With `ripple`, what comes after it moves back by its length, the scene's end
 * included, as a magnetic timeline closes the gap.
 */
export function removeClip(
  sources: VideoSources,
  file: string,
  clip: VideoTarget,
  options: { readonly ripple?: boolean; readonly endMs?: number } = {}
): VideoEditResult {
  return run(sources, (work) => {
    const found = clipOf(work, file, clip)

    // A clip that goes on in later scenes goes whole.
    const chain = file === VIDEO_ENTRY ? undefined : chainsOf(work).get(`${file}\n${found.ref}`)
    if (chain) {
      removeFound(work, chain.parts, options.ripple === true)
      return
    }

    const end = clipEnd(found, options.endMs)
    // What followed it keeps its time: its name will name nothing.
    if (found.id) freezeFollowers(work, file, (each) => each.id === found.id)

    const removed = clipOf(work, file, clip)
    const block = lineBlock(work.text(file), removed.source.element)
    work.replace(file, block.start, block.end, "")
    pruneLooks(work, file)
    if (options.ripple) rippleRemove(work, file, [{ startMs: found.startMs, endMs: end }])
  })
}

// Several clips ----------------------------------------------------------------------------------

/** A clip of one of the video's files, as an operation on several clips names it. */
export interface VideoClipTarget {
  /** Its file: a scene's, or `index.html` for the video's own. */
  readonly file: string
  readonly clip: VideoTarget
}

/**
 * A clip that left a scene whose script animates it: its look came with it, the motion the
 * script writes could not.
 */
export interface VideoAnimationLeft {
  /** Where the clip is now. */
  readonly clip: VideoClipTarget
  /** The scene it left, whose script still names it. */
  readonly scene: string
}

/**
 * A clip that landed in a scene whose script animates what it is, a class of it or its tag: that
 * motion now plays on it too.
 */
export interface VideoAnimationJoined {
  /** Where the clip is now. */
  readonly clip: VideoClipTarget
  /** The scene it landed in, whose script reaches it. */
  readonly scene: string
}

/**
 * An edit that places clips in the video, as a move, an end trim or an import does: a clip of a
 * scene lives in the scene that plays where it starts, its own while that holds it, else the one
 * on top there, and goes on past that scene's end as a copy in the next, playing on from where it
 * stopped; the last scene grows to hold it. `clips` names each clip placed where it now starts, in
 * the order given, `animationsLeft` each that left a scene whose script animates it, and
 * `animationsJoined` each that landed in one whose script animates what it is, and
 * `looksMayDiffer` each whose look could not all be taken along.
 */
export type VideoPlaceResult = VideoEditResult & {
  readonly clips?: readonly VideoClipTarget[]
  readonly animationsLeft?: readonly VideoAnimationLeft[]
  readonly animationsJoined?: readonly VideoAnimationJoined[]
  /**
   * Each clip that landed in another scene where a rule may style it that its look could not take
   * along, one through a wrapper or by its place among its siblings: it may look a little different.
   */
  readonly looksMayDiffer?: readonly VideoClipTarget[]
}

/**
 * Moves clips together by `deltaMs`, as one edit: they keep their places one to another, none
 * before the video's start, so the whole group moves less. Each clip of a scene lands in the scene
 * that plays where it now starts, and goes on in the next scene past that one's end; the last
 * scene grows to hold it (see {@link VideoPlaceResult}). The video's own clips stay its own.
 */
export function moveClips(
  sources: VideoSources,
  clips: readonly VideoClipTarget[],
  deltaMs: number
): VideoPlaceResult {
  return placing(sources, (work) => moveFound(work, clipsOf(work, clips), deltaMs))
}

/**
 * Removes clips at once, each from its own file, as {@link removeClip} removes one. With `ripple`,
 * each file closes the gaps its clips leave, as one cut of all their stretches. `endMs` is where
 * a clip that writes no length ends.
 */
export function removeClips(
  sources: VideoSources,
  clips: readonly (VideoClipTarget & { readonly endMs?: number })[],
  options: { readonly ripple?: boolean } = {}
): VideoEditResult {
  return run(sources, (work) => {
    // A clip that goes on in later scenes goes whole, each of its parts once.
    const chains = chainsOf(work)
    const found = new Map<string, { file: string; clip: VideoClip; endMs?: number }>()
    for (const each of clipsOf(work, clips)) {
      const endMs = clips[each.index]?.endMs
      const parts = chains.get(`${each.file}\n${each.clip.ref}`)?.parts ?? [each]
      for (const part of parts) {
        found.set(`${part.file}\n${part.clip.ref}`, {
          file: part.file,
          clip: part.clip,
          ...(endMs === undefined ? {} : { endMs }),
        })
      }
    }
    removeFound(work, [...found.values()], options.ripple === true)
  })
}

/**
 * Removes clips found in their files, and the looks they carried. With `ripple`, each file closes
 * the gaps its clips leave, as one cut of all their stretches.
 */
function removeFound(
  work: Working,
  found: readonly { readonly file: string; readonly clip: VideoClip; readonly endMs?: number }[],
  ripple: boolean
): void {
  for (const [file, each] of byFile(found)) {
    const stretches = each.map(({ clip, endMs }) => ({
      startMs: clip.startMs,
      endMs: clipEnd(clip, endMs),
    }))

    // What followed them keeps its time: their names will name nothing.
    const ids = new Set(each.flatMap(({ clip }) => (clip.id ? [clip.id] : [])))
    freezeFollowers(work, file, (clip) => clip.id !== undefined && ids.has(clip.id))

    rewriteClips(work, file, new Map(each.map(({ clip }) => [clip.ref, "remove" as const])))
    pruneLooks(work, file)
    if (ripple) rippleRemove(work, file, stretches)
  }
}

/**
 * Splits clips at once, each at its own `atMs` from its composition's start, as {@link splitClip}
 * splits one. Returns the second part of each, in the order they are named.
 */
export function splitClips(
  sources: VideoSources,
  splits: readonly (VideoClipTarget & { readonly atMs: number; readonly endMs?: number })[]
): VideoEditResult & { readonly clips?: readonly VideoClipTarget[] } {
  const parts: (VideoClipTarget | undefined)[] = []
  const result = run(sources, (work) => {
    const found = clipsOf(work, splits)
    const chains = chainsOf(work)

    for (const [file, each] of byFile(found)) {
      // From the last in the file to the first: a part added shifts only the places after it.
      const lastFirst = [...each].sort(
        (a, b) => b.clip.source.element.start - a.clip.source.element.start
      )
      for (const { clip, index } of lastFirst) {
        const split = splits[index]
        if (!split) continue

        const now = clipOf(work, file, clip.ref)
        const second = splitChained(work, chains, file, now, split.atMs, split.endMs)
        if (second) parts[index] = { file, clip: second }
      }
    }
  })
  return "edit" in result
    ? { ...result, clips: parts.filter((part) => part !== undefined) }
    : result
}

/**
 * Keeps only these stretches of a clip's file, in milliseconds into it: the clip becomes one clip
 * per stretch, each starting where the one before ends, and what played after the clip moves
 * back by what was cut, the scene's end included. What is cut out of the timeline goes with it,
 * such as the captions of words no longer said. A clip that goes on keeps them in every part,
 * each part cutting what it plays of the rest.
 */
export function keepClipRanges(
  sources: VideoSources,
  file: string,
  clip: VideoTarget,
  ranges: readonly VideoRange[],
  options: { readonly endMs?: number } = {}
): VideoEditResult {
  return run(sources, (work) => {
    const found = clipOf(work, file, clip)
    if (!playsFile(found)) throw new EditError(`'${found.ref}' plays no recording.`)

    const cuts = new Map<string, VideoRange[]>()
    let left = false
    for (const part of chainParts(work, file, [found])) {
      const from = part.clip.mediaStartMs
      const end = clipEnd(part.clip, part.file === file ? options.endMs : undefined)
      const to = from + end - part.clip.startMs
      const kept = mergeRanges(
        ranges.map((range) => ({
          startMs: Math.max(from, Math.round(range.startMs)),
          endMs: Math.min(to, Math.round(range.endMs)),
        }))
      ).filter((range) => range.endMs - range.startMs >= MIN_CLIP_MS)
      if (kept.length > 0) left = true

      // What is cut, as stretches of its composition's timeline.
      const cut = cuts.get(part.file) ?? []
      cuts.set(part.file, cut)
      let cursor = from
      for (const range of [...kept, { startMs: to, endMs: to }]) {
        if (range.startMs - cursor > 0) {
          cut.push({
            startMs: part.clip.startMs + cursor - from,
            endMs: part.clip.startMs + range.startMs - from,
          })
        }
        cursor = range.endMs
      }
    }
    if (!left) throw new EditError("Nothing of the clip would be left: remove it instead.")

    for (const [each, cut] of cuts) if (cut.length > 0) rippleRemove(work, each, cut)
  })
}

/**
 * Cuts stretches of a recording, in milliseconds into its file, wherever the composition plays
 * them: each clip of `src` loses what it played of them, as {@link keepClipRanges} cuts one
 * clip, and what followed moves back. A transcript's words cut out are such stretches. A clip
 * that goes on loses them in every part, so words across a scene's edge go whole.
 */
export function removeMediaRanges(
  sources: VideoSources,
  file: string,
  src: string,
  ranges: readonly VideoCut[],
  options: { readonly endMs?: number } = {}
): VideoEditResult {
  return run(sources, (work) => {
    const removed = mergeCuts(ranges)
    const played = timelineOf(work, file).clips.filter(
      (clip) => clip.src === src && playsFile(clip)
    )
    const parts = chainParts(work, file, played)
    const endOf = (part: { readonly file: string; readonly clip: VideoClip }) =>
      clipEnd(part.clip, part.file === file ? options.endMs : undefined)

    const cuts = new Map<string, VideoCut[]>()
    for (const part of parts) {
      const { clip } = part
      // From the file's time to the composition's, within what the clip plays.
      const from = clip.mediaStartMs
      const to = from + endOf(part) - clip.startMs
      const at = (ms: number) => clip.startMs + Math.min(to, Math.max(from, ms)) - from

      const cut = cuts.get(part.file) ?? []
      cuts.set(part.file, cut)
      for (const range of removed) {
        const startMs = at(range.startMs)
        const endMs = at(range.endMs)
        if (endMs <= startMs) continue

        const room = range.room ?? range
        cut.push({ startMs, endMs, room: { startMs: at(room.startMs), endMs: at(room.endMs) } })
      }
    }
    if ([...cuts.values()].every((cut) => cut.length === 0)) return

    const left = parts.some((part) =>
      subtractRanges(
        { startMs: part.clip.startMs, endMs: endOf(part) },
        mergeRanges(cuts.get(part.file) ?? [])
      ).some((piece) => piece.endMs - piece.startMs >= MIN_CLIP_MS)
    )
    if (!left) throw new EditError("Nothing of the recording would be left: remove it instead.")
    for (const [each, cut] of cuts) if (cut.length > 0) rippleRemove(work, each, cut)
  })
}

/**
 * The clips of a file, each with every part it goes on in, wherever that is, each once: what a
 * cut by the words of a recording cuts.
 */
function chainParts(
  work: Working,
  file: string,
  clips: readonly VideoClip[]
): { readonly file: string; readonly clip: VideoClip }[] {
  const chains = clips.length > 0 && file !== VIDEO_ENTRY ? chainsOf(work) : new Map()
  const parts = new Map<string, { readonly file: string; readonly clip: VideoClip }>()
  for (const clip of clips) {
    const chain = chains.get(`${file}\n${clip.ref}`)
    for (const part of chain?.parts ?? [{ file, clip }]) {
      parts.set(`${part.file}\n${part.clip.ref}`, { file: part.file, clip: part.clip })
    }
  }
  return [...parts.values()]
}

/**
 * Takes a stretch out of the video, in milliseconds from its start, as a magnetic timeline deletes
 * a range: each scene loses what it shows of it, from its start up to where the next scene starts,
 * so a crossfade is cut once. Every clip of a scene loses what played then, a recording cut
 * through is split around it, and what followed moves back; a scene the range covers whole goes.
 */
export function cutRange(sources: VideoSources, range: VideoRange): VideoEditResult {
  return run(sources, (work) => {
    const startMs = Math.max(0, Math.round(range.startMs))
    const endMs = Math.round(range.endMs)
    if (endMs - startMs < MIN_CLIP_MS) {
      throw new EditError(`A cut lasts at least ${MIN_CLIP_MS} ms.`)
    }

    const scenes = [...openRoot(work).scenes].sort((a, b) => a.startMs - b.startMs)
    const shares = scenes.map((scene, index) => {
      const until = Math.min(
        scene.startMs + scene.durationMs,
        scenes[index + 1]?.startMs ?? Number.POSITIVE_INFINITY
      )
      return {
        scene,
        from: Math.max(startMs, scene.startMs),
        to: Math.min(endMs, until),
        whole: startMs <= scene.startMs + SAME_MS && endMs >= until - SAME_MS,
      }
    })

    // From the last: a cut moves only what comes after it, so each scene before is where it was.
    for (const { scene, from, to, whole } of shares.reverse()) {
      if (to - from < SAME_MS) continue

      if (whole) dropScene(work, scene.id)
      else {
        rippleRemove(work, scene.src, [
          { startMs: from - scene.startMs, endMs: to - scene.startMs },
        ])
      }
    }
  })
}

/**
 * Adds a clip that plays or shows a file of the video, at `startMs` in its composition, for
 * `durationMs`: footage fills the frame under what the scene shows, a sound plays under it. It is
 * placed as {@link moveClips} places a clip: past its scene's end, it goes on in the next scene,
 * or the last scene grows to hold it. Footage added where another clip is heard is added muted,
 * as B-roll over a voice is, which `muted` says. Returns the clip's id with the edit.
 */
export function insertClip(
  sources: VideoSources,
  file: string,
  clip: {
    readonly kind: VideoImportKind
    readonly src: string
    readonly startMs: number
    readonly durationMs: number
    readonly mediaStartMs?: number
  }
): VideoEditResult & { readonly clip?: string; readonly muted?: true } {
  let added: string | undefined
  let muted = false
  const result = run(sources, (work) => {
    if (!sources.has(clip.src))
      throw new EditError(`'${clip.src}' is not one of the video's files.`)
    if (!(clip.durationMs >= MIN_CLIP_MS)) {
      throw new EditError(`A clip lasts at least ${MIN_CLIP_MS} ms.`)
    }

    const timeline = timelineOf(work, file)
    const stem = clip.src.replace(/^.*\//, "").replace(/\.[^.]*$/, "")
    const id = uniqueName(slug(stem) || clip.kind, takenNames(work))
    added = id

    const startMs = (sceneOf(work, file)?.startMs ?? 0) + Math.max(0, clip.startMs)
    muted = clip.kind === "video" && heardDuring(work, startMs, startMs + clip.durationMs)
    const html = clipHtml(clip.kind, {
      id,
      // A scene reads a path from the project's root, unless one beside it is the version's.
      src: clip.src,
      start: seconds(Math.max(0, clip.startMs)),
      duration: seconds(clip.durationMs),
      mediaStart: seconds(clip.mediaStartMs ?? 0),
      muted,
    })

    // A picture goes over the pictures before it and under the words; a sound beside the sounds.
    const track = clip.kind === "audio" ? "sound" : "picture"
    insertInComposition(work, file, timeline, [html], track)

    const found = clipOf(work, file, id)
    placeFound(work, [
      { file, clip: found, startMs: videoStartOf(work, file, found), durationMs: clip.durationMs },
    ])
  })
  if (!("edit" in result) || !added) return result
  return { ...result, clip: added, ...(muted ? { muted: true as const } : {}) }
}

/**
 * Whether a clip of the video is heard between `fromMs` and `toMs`: a sound, or footage that is not
 * muted, at a volume above none, the video's own or a scene's.
 */
function heardDuring(work: Working, fromMs: number, toMs: number): boolean {
  const files = [
    { file: VIDEO_ENTRY, startMs: 0, endMs: Number.POSITIVE_INFINITY },
    ...rootOf(work).scenes.map((scene) => ({
      file: scene.src,
      startMs: scene.startMs,
      endMs: scene.startMs + scene.durationMs,
    })),
  ]
  return files.some(({ file, startMs, endMs }) => {
    if (work.textOf(file) === undefined) return false
    return (readTimeline(work, file)?.clips ?? []).some((clip) => {
      const sounds = clip.kind === "audio" || (clip.kind === "video" && !clip.silent)
      if (!sounds || clip.volume === 0) return false
      const from = startMs + clip.startMs
      const to = Math.min(endMs, clip.durationMs === undefined ? endMs : from + clip.durationMs)
      return from < toMs && fromMs < to
    })
  })
}

/** The files an edit leaves: `sources` with the edit applied. */
export function applyVideoEdit(sources: VideoSources, edit: VideoEdit): Map<string, string | null> {
  const files = new Map(sources)
  for (const each of edit) {
    if ("remove" in each) files.delete(each.path)
    else if ("create" in each) files.set(each.path, each.create)
    else files.set(each.path, applyTextChanges(files.get(each.path) ?? "", each.changes))
  }
  return files
}

/** A text with its changes applied, from the last, so each index names its place. */
function applyTextChanges(text: string, changes: readonly VideoTextChange[]): string {
  let result = text
  for (const change of [...changes].sort((a, b) => b.index - a.index)) {
    result =
      result.slice(0, change.index) + change.insert + result.slice(change.index + change.remove)
  }
  return result
}

/** A file's clips and texts, as an editor lays them out: `index.html`'s own, or a scene's. */
export function readVideoFileTimeline(file: string, html: string): VideoFileTimeline | null {
  return file === VIDEO_ENTRY ? readRootTimeline(html) : readSceneTimeline(html)
}

// The working copy --------------------------------------------------------------------------------

class EditError extends Error {}

/** The files as an operation changes them. */
class Working {
  private readonly files: Map<string, string | null>
  /**
   * The root as it was before the operation moved a scene, once it has: from then on the root
   * writes room for any length, so each step reads, and the last writes the length it ends with.
   */
  opened: VideoRoot | undefined
  /**
   * The clips that go on, as the operation found them before it cut any, and what each cut left
   * of their parts, by `file\nref`: the pieces' ids, none for a part cut whole.
   */
  marking:
    | {
        readonly chains: ReadonlyMap<string, VideoChain>
        readonly pieces: Map<string, readonly string[]>
      }
    | undefined
  /** Text each file's edit writes whole, though it holds it as it did: see {@link wholeAgain}. */
  private readonly whole = new Map<string, Set<string>>()
  /** Each file's timeline as last read, kept while its text is the one it was read from. */
  readonly timelines = new Map<
    string,
    { readonly text: string; readonly timeline: VideoFileTimeline | null }
  >()

  constructor(readonly sources: VideoSources) {
    this.files = new Map(sources)
  }

  text(path: string): string {
    const text = this.files.get(path)
    if (typeof text !== "string") {
      throw new EditError(`'${path}' is not one of the video's HTML files.`)
    }
    return text
  }

  has(path: string): boolean {
    return this.files.has(path)
  }

  /** A text file's text, undefined for one that is not the video's or holds bytes. */
  textOf(path: string): string | undefined {
    const text = this.files.get(path)
    return typeof text === "string" ? text : undefined
  }

  paths(): string[] {
    return [...this.files.keys()]
  }

  replace(path: string, start: number, end: number, insert: string): void {
    const text = this.text(path)
    this.files.set(path, text.slice(0, start) + insert + text.slice(end))
  }

  create(path: string, text: string): void {
    this.files.set(path, text)
  }

  remove(path: string): void {
    this.files.delete(path)
  }

  /** The paths whose text the operation changed so far. */
  changed(): string[] {
    return [...this.files].flatMap(([path, text]) =>
      typeof text === "string" && this.sources.get(path) !== text ? [path] : []
    )
  }

  /** Writes `text`, which the file holds as it did, whole in its edit. */
  writeWhole(path: string, text: string): void {
    this.whole.set(path, (this.whole.get(path) ?? new Set()).add(text))
  }

  /** The files now, and the edit from what they were: each text's changes, as `diffText` finds them. */
  result(): { readonly edit: VideoEdit; readonly files: ReadonlyMap<string, string | null> } {
    const edit: VideoFileEdit[] = []
    for (const [path, text] of this.files) {
      const before = this.sources.get(path)
      if (text === null || before === text) continue
      if (typeof before !== "string") {
        edit.push({ path, create: text })
        continue
      }
      edit.push({
        path,
        changes: wholeAgain(before, text, textChanges(before, text), this.whole.get(path)),
      })
    }
    for (const path of this.sources.keys()) {
      if (!this.files.has(path)) edit.push({ path, remove: true })
    }
    return { edit, files: this.files }
  }
}

/**
 * A file's changes, each text of `whole` it holds as it did written again whole among them: what
 * no change touches is then this edit's too, so another edit that removes it at once leaves this
 * one's copy. An insertion just before it goes with it; one inside, and it was written anyway.
 */
function wholeAgain(
  before: string,
  after: string,
  changes: readonly VideoTextChange[],
  whole: ReadonlySet<string> | undefined
): VideoTextChange[] {
  const result = [...changes]
  for (const text of whole ?? []) {
    const start = before.indexOf(text)
    const end = start + text.length
    if (start < 0 || !after.includes(text)) continue

    const inside = result.some((change) =>
      change.remove > 0
        ? change.index < end && change.index + change.remove > start
        : change.index > start && change.index < end
    )
    if (inside) continue
    const at = result.findIndex((change) => change.remove === 0 && change.index === start)
    const ahead = result[at]
    if (ahead) result[at] = { index: start, remove: text.length, insert: ahead.insert + text }
    else result.push({ index: start, remove: text.length, insert: text })
  }
  return result.sort((a, b) => a.index - b.index)
}

/**
 * The changes from `before` to `after`: the live layer's line diff, and within a run of lines
 * changed one for one, each line narrowed to the attributes and words that changed in it, so two
 * values written again on one line are two changes. A run that adds or removes lines, such as a host
 * moved or a clip split, stays whole: its lines are what changed.
 */
function textChanges(before: string, after: string): VideoTextChange[] {
  return diffText(before, after).flatMap((edit) => {
    // The diff narrows each run to its characters: the lines around them are read whole.
    const start = before.lastIndexOf("\n", edit.start - 1) + 1
    const lineEnd = before.indexOf("\n", edit.end)
    const end = lineEnd < 0 ? before.length : lineEnd
    const insert = before.slice(start, edit.start) + edit.insert + before.slice(edit.end, end)

    const removed = textLines(before.slice(start, end))
    const added = textLines(insert)
    if (removed.length !== added.length || removed.length === 0) {
      return [{ index: edit.start, remove: edit.end - edit.start, insert: edit.insert }]
    }

    const changes: VideoTextChange[] = []
    let at = start
    removed.forEach((line, index) => {
      const next = added[index] ?? ""
      // Two lines that share little are two elements, one in the other's place: the line goes
      // whole, rather than one element's characters becoming another's.
      if (!alike(line, next)) {
        changes.push({ index: at, remove: line.length, insert: next })
        at += line.length
        return
      }
      // Token by token: an attribute written again is one change, never a few of its letters.
      const from = tokens(line)
      const to = tokens(next)
      const fromAt = offsets(from)
      const toAt = offsets(to)
      for (const hunk of diffSequences(from, to)) {
        const index = fromAt[hunk.aStart] ?? 0
        changes.push({
          index: at + index,
          remove: (fromAt[hunk.aEnd] ?? line.length) - index,
          insert: next.slice(toAt[hunk.bStart] ?? 0, toAt[hunk.bEnd] ?? next.length),
        })
      }
      at += line.length
    })
    return changes
  })
}

/**
 * A line's words, spaces, and each mark between them, which together write it again. An attribute
 * is one token with the space before it: two people writing its value at once then leave it twice,
 * `data-duration="8" data-duration="12"`, which reads as the first, rather than `"812"`.
 */
function tokens(line: string): string[] {
  return (
    line.match(/\s+[^\s"'<>/=]+=(?:"[^"]*"|'[^']*')|\s+|[A-Za-z0-9_.:+-]+|[^\sA-Za-z0-9_.:+-]/g) ??
    []
  )
}

/** Where each token starts, and the end past the last. */
function offsets(parts: readonly string[]): number[] {
  const at = [0]
  for (const part of parts) at.push((at.at(-1) ?? 0) + part.length)
  return at
}

/** Whether two lines are one written again: what they start and end alike is most of them. */
function alike(left: string, right: string): boolean {
  let head = 0
  while (head < left.length && head < right.length && left[head] === right[head]) head += 1
  let tail = 0
  while (
    tail < left.length - head &&
    tail < right.length - head &&
    left[left.length - 1 - tail] === right[right.length - 1 - tail]
  ) {
    tail += 1
  }
  return (head + tail) * 2 >= Math.max(left.length, right.length)
}

/** Runs an operation on a working copy, and checks that what it leaves is still a video. */
function run(sources: VideoSources, operation: (work: Working) => void): VideoEditResult {
  const work = new Working(sources)
  try {
    operation(work)
    markCutChains(work)
    // Scenes moved, or a file holding parts of a clip that goes on changed: its parts agree again.
    if (work.opened || work.changed().some((path) => holdsParts(work, path))) settleChains(work)
    if (work.opened) fitRoot(work, work.opened)
  } catch (error) {
    if (error instanceof EditError) return { error: error.message }
    throw error
  }

  const { edit, files } = work.result()
  const index = files.get(VIDEO_ENTRY)
  if (typeof index !== "string") return { error: `A video needs '${VIDEO_ENTRY}'.` }

  const read = readVideoComposition(index, (path) => {
    const text = files.get(path)
    return typeof text === "string" ? text : undefined
  })
  if ("error" in read) return { error: read.error }

  for (const scene of read.composition.scenes) {
    if (!readSceneTimeline(files.get(scene.src) as string)) {
      return { error: `${scene.src}: a scene file is one <template> holding its composition.` }
    }
  }

  // No HTML file grows past what publishing reads, as a look carried in for many clips might.
  const limit = ARTIFACT_LIMITS.maxSceneBytes
  for (const change of edit) {
    if (!/\.html?$/i.test(change.path) || "remove" in change) continue
    const after = new TextEncoder().encode(files.get(change.path) ?? "").length
    const before = new TextEncoder().encode(sources.get(change.path) ?? "").length
    if (after > limit && after > before) {
      return {
        error: `'${change.path}' would be ${after} bytes: each of a video's HTML files holds at most ${limit}.`,
        refusal: "too_large",
      }
    }
  }
  return { edit: [...edit, ...unplayed(sources, files, edit)] }
}

/**
 * The recordings and pictures an edit took the last clip of: each leaves the version with it, and
 * an undo of the edit brings it back. Only those a file the edit changed named, and no file names
 * now: what nothing played before it stays, as the Agent may have put it there for later.
 */
function unplayed(
  sources: VideoSources,
  files: ReadonlyMap<string, string | null>,
  edit: VideoEdit
): VideoFileEdit[] {
  const exists = (path: string) => files.has(path)
  const named = (path: string, text: string | null | undefined) =>
    new Set(
      [...(text ?? "").matchAll(/\ssrc\s*=\s*(["'])([^"']+)\1/gi)].flatMap((match) => {
        const found = videoFilePath(path, match[2] ?? "", (each) => sources.has(each))
        return found === undefined ? [] : [found]
      })
    )

  const gone = new Set<string>()
  for (const change of edit) {
    if (!/\.html?$/i.test(change.path)) continue
    const now = named(change.path, files.get(change.path))
    for (const path of named(change.path, sources.get(change.path))) {
      if (!now.has(path) && sources.get(path) === null && files.has(path)) gone.add(path)
    }
  }
  if (gone.size === 0) return []

  const index = files.get(VIDEO_ENTRY)
  if (typeof index !== "string") return []
  const played = videoFilesPlayed(
    index,
    (path) => {
      const text = files.get(path)
      return typeof text === "string" ? text : undefined
    },
    exists
  )
  return [...gone]
    .filter((path) => !played.has(path))
    .map((path) => ({ path, remove: true as const }))
}

/** Runs an operation that places clips, and returns where it placed them with its edit. */
function placing(
  sources: VideoSources,
  operation: (work: Working) => Placement | undefined
): VideoPlaceResult {
  let placement: Placement | undefined
  const result = run(sources, (work) => {
    placement = operation(work)
  })
  return "edit" in result && placement ? { ...result, ...placement } : result
}

// Scenes, inside ----------------------------------------------------------------------------------

function rootOf(work: Working): VideoRoot {
  const read = parseVideoRoot(work.text(VIDEO_ENTRY))
  if (!("error" in read)) return read.root

  // Once open, the root has room for any length a video may have: a scene past it is too long.
  if (work.opened && read.error.includes("after the root composition's data-duration")) {
    throw new EditError(`A video lasts at most ${ARTIFACT_LIMITS.maxVideoSeconds} s.`)
  }
  throw new EditError(read.error)
}

/**
 * The root before the operation moves its first scene, read once: the root then writes room for
 * any length, so that each step after reads as a video whatever the scenes' end, until
 * {@link fitRoot} writes the length it ends with.
 */
function openRoot(work: Working): VideoRoot {
  if (work.opened) return work.opened

  const before = rootOf(work)
  work.opened = before
  if (before.root.attributes["data-duration"]) {
    setAttributes(work, VIDEO_ENTRY, before.root, {
      "data-duration": String(ARTIFACT_LIMITS.maxVideoSeconds),
    })
  }
  return before
}

function hostOf(work: Working, scene: string): VideoRoot["scenes"][number] {
  const found = rootOf(work).scenes.find((each) => each.id === scene)
  if (!found) throw new EditError(noScene(scene))
  return found
}

/** The scene a file is, if it is one. */
function sceneOf(work: Working, file: string): VideoRoot["scenes"][number] | undefined {
  if (file === VIDEO_ENTRY) return undefined
  return rootOf(work).scenes.find((each) => each.src === file)
}

function noScene(scene: string): string {
  return `The video has no scene '${scene}'.`
}

/** Writes a scene's length, and moves the scenes at a number of seconds after it as much. */
function lengthenScene(work: Working, scene: string, ms: number): void {
  openRoot(work)
  const now = rootOf(work)
  const host = now.scenes.find((each) => each.id === scene)
  if (!host) throw new EditError(noScene(scene))

  const delta = ms - host.durationMs
  if (delta === 0) return

  const end = host.startMs + host.durationMs
  setAttributes(work, VIDEO_ENTRY, host.host, { "data-duration": seconds(ms) })
  for (const each of now.scenes) {
    if (each.id === scene || each.start.type !== "at" || each.startMs < end - SAME_MS) continue
    setAttributes(work, VIDEO_ENTRY, hostOf(work, each.id).host, {
      "data-start": seconds(Math.max(0, each.startMs + delta)),
    })
  }
}

/**
 * Removes a scene from the root as it is now: its host, and its file unless another scene plays
 * it. The scenes that followed it start where it started, keeping their own overlap or gap.
 */
function dropScene(work: Working, scene: string): void {
  const now = rootOf(work)
  const removed = now.scenes.find((each) => each.id === scene)
  if (!removed) throw new EditError(noScene(scene))
  if (now.scenes.length === 1) throw new EditError("A video keeps at least one scene.")

  const end = removed.startMs + removed.durationMs
  for (const each of now.scenes) {
    if (each.id === scene) continue

    if (startsAfter(each.start, removed)) {
      const offset = each.start.type === "after" ? each.start.offset : 0
      const start =
        removed.start.type === "at"
          ? seconds(Math.max(0, removed.startMs + offset * 1000))
          : chainedStart(removed.start.scene, removed.start.offset + offset)
      setAttributes(work, VIDEO_ENTRY, hostOf(work, each.id).host, { "data-start": start })
    } else if (each.start.type === "at" && each.startMs >= end - SAME_MS) {
      setAttributes(work, VIDEO_ENTRY, hostOf(work, each.id).host, {
        "data-start": seconds(each.startMs - removed.durationMs),
      })
    }
  }

  const block = lineBlock(work.text(VIDEO_ENTRY), hostOf(work, scene).host.element)
  work.replace(VIDEO_ENTRY, block.start, block.end, "")
  if (!now.scenes.some((each) => each.id !== scene && each.src === removed.src)) {
    work.remove(removed.src)
  }
}

/** Whether a scene's start names `scene`, by its id or its host's own. */
function startsAfter(start: VideoStart, scene: { readonly id: string; readonly hostId?: string }) {
  return start.type === "after" && (start.scene === scene.id || start.scene === scene.hostId)
}

/**
 * How long after the scene before it a scene starts, in seconds, sooner when negative: its own
 * offset when it names that scene, else the gap it leaves after it.
 */
function gapBefore(scenes: VideoRoot["scenes"], scene: VideoRoot["scenes"][number]): number {
  if (scene.start.type === "after") return scene.start.offset

  const previous = scenes[scenes.findIndex((each) => each.id === scene.id) - 1]
  if (!previous) return 0
  return (scene.startMs - previous.startMs - previous.durationMs) / 1000
}

/** `data-start` for a scene that starts when `after` ends, `offset` seconds later or sooner. */
function chainedStart(after: string, offset: number): string {
  const amount = Math.round(Math.abs(offset) * 1000) / 1000
  if (amount === 0) return after
  return `${after} ${offset < 0 ? "-" : "+"} ${amount}`
}

/**
 * Stacks the scenes on screen together in play order, the later on top, as a crossfade shows it.
 * HyperFrames positions each host and paints them in the file's order unless a `z-index` says
 * otherwise. A host never moves its line, which someone else may be editing at once; each host that
 * must sit above one later in the file writes the least `z-index` that puts it there, and drops one
 * it no longer needs. Scenes never on screen together cover nothing, so their order does not count.
 *
 * What the root paints of its own over the scenes, a captions bar, stays over them: once a scene
 * has a layer, each writes one above the highest, and drops it with the last.
 */
function restack(work: Working): void {
  const text = work.text(VIDEO_ENTRY)
  const play = rootOf(work).scenes
  const line = new Map(
    [...play]
      .sort((a, b) => a.host.element.start - b.host.element.start)
      .map((scene, index) => [scene.id, index])
  )

  // From the first to start, each scene's least layer above every scene on screen with it before.
  const wanted = new Map<string, number>()
  play.forEach((each, index) => {
    let least = 0
    for (const below of play.slice(0, index)) {
      if (!together(below, each)) continue
      const under = wanted.get(below.id) ?? 0
      const later = (line.get(each.id) ?? 0) > (line.get(below.id) ?? 0)
      least = Math.max(least, later ? under : under + 1)
    }
    wanted.set(each.id, least)
  })

  const writes: { readonly source: VideoElementSource; readonly layer: number }[] = []
  for (const scene of play) {
    const layer = wanted.get(scene.id) ?? 0
    if (layer !== layerOf(text, scene.host)) writes.push({ source: scene.host, layer })
  }

  // The root's own layer is one above the highest scene's, so one it wrote is that, and one
  // written higher is someone's own, kept.
  const was = Math.max(0, ...play.map((scene) => layerOf(text, scene.host)))
  const top = Math.max(0, ...wanted.values())
  for (const source of readRootLayers(text)) {
    const layer = layerOf(text, source)
    const own = was > 0 && layer === was + 1
    if (top === 0 && own) writes.push({ source, layer: 0 })
    else if (top > 0 && layer !== top + 1 && (own || layer <= top)) {
      writes.push({ source, layer: top + 1 })
    }
  }

  // From the last in the file, so each span read still names what it named.
  for (const { source, layer } of writes.sort((a, b) => b.source.tag.start - a.source.tag.start)) {
    const style = source.attributes.style
    setAttributes(work, VIDEO_ENTRY, source, {
      style: withLayer(style ? attributeValue(text, style) : undefined, layer),
    })
  }
}

type Stacked = VideoRoot["scenes"][number]

/** Whether two scenes are on screen together, for longer than a rounding. */
function together(a: Stacked, b: Stacked): boolean {
  return (
    a.startMs < b.startMs + b.durationMs - SAME_MS && b.startMs < a.startMs + a.durationMs - SAME_MS
  )
}

/** An element's `z-index`, as its `style` writes it: 0 for none. */
function layerOf(text: string, source: Pick<VideoElementSource, "attributes">): number {
  const at = source.attributes.style
  const style = at ? attributeValue(text, at) : undefined
  const written = style && /(?:^|;)\s*z-index\s*:\s*(-?\d+)\s*(?:;|$)/i.exec(style)
  return written ? Number(written[1]) : 0
}

/** A `style` whose `z-index` is `layer`, or has none at 0: null once nothing else is left. */
function withLayer(style: string | undefined, layer: number): string | null {
  const rest = (style ?? "")
    .split(";")
    .map((each) => each.trim())
    .filter((each) => each !== "" && !/^z-index\s*:/i.test(each))
  if (layer > 0) rest.push(`z-index: ${layer}`)
  return rest.length > 0 ? rest.join("; ") : null
}

/**
 * Writes the root's length once its scenes moved: what it played past the last scene, it still
 * plays past it, and a sound of its own that ran to its end runs to the new one. What the root
 * plays during one scene, a line of voice-over, moves with that scene, and goes with it; so does
 * the poster, kept within it. A poster past the end moves to its last frame.
 */
function fitRoot(work: Working, before: VideoRoot): void {
  const now = rootOf(work)
  const end = (root: VideoRoot) =>
    Math.max(...root.scenes.map((scene) => scene.startMs + scene.durationMs))
  const tail = Math.max(0, before.durationMs - end(before))
  const duration = end(now) + tail

  // Where each scene of the root before now is: none for one removed.
  const moved = (scene: VideoRoot["scenes"][number] | undefined) =>
    scene && now.scenes.find((each) => each.id === scene.id)

  // A clip of the root's own goes with the scene it belongs to, and keeps its time into it. Once
  // that scene is gone, what followed it keeps its time, as when a clip is removed.
  const owners = new Map<string, VideoRoot["scenes"][number]>()
  for (const clip of readRootTimeline(work.text(VIDEO_ENTRY))?.clips ?? []) {
    const owner = numericStart(work, VIDEO_ENTRY, clip) ? sceneOfClip(before, clip) : undefined
    if (owner) owners.set(clip.ref, owner)
  }
  freezeFollowers(work, VIDEO_ENTRY, (clip) => {
    const owner = owners.get(clip.ref)
    return owner !== undefined && !moved(owner)
  })

  const plan = new Map<string, ClipChange>()
  for (const clip of readRootTimeline(work.text(VIDEO_ENTRY))?.clips ?? []) {
    const owner = owners.get(clip.ref)
    const scene = moved(owner)
    if (owner && !scene) {
      plan.set(clip.ref, "remove")
      continue
    }

    const start = scene && owner ? clip.startMs + scene.startMs - owner.startMs : clip.startMs
    const change: Record<string, string> = {}
    if (start !== clip.startMs) change["data-start"] = seconds(start)

    // A sound that ran to the video's end runs to its new one.
    if (
      duration !== before.durationMs &&
      clip.durationMs !== undefined &&
      Math.abs(clip.startMs + clip.durationMs - before.durationMs) <= SAME_MS &&
      duration - start >= MIN_CLIP_MS
    ) {
      change["data-duration"] = seconds(duration - start)
    }
    if (Object.keys(change).length > 0) plan.set(clip.ref, change)
  }
  rewriteClips(work, VIDEO_ENTRY, plan)
  pruneLooks(work, VIDEO_ENTRY)

  // Its length and its poster at once: either alone may not read as a video.
  const poster = posterAfter(before, now, duration)
  setAttributes(work, VIDEO_ENTRY, rootOf(work).root, {
    ...(before.root.attributes["data-duration"] ? { "data-duration": seconds(duration) } : {}),
    ...(poster === undefined || poster === before.posterMs
      ? {}
      : { "data-poster": seconds(poster) }),
  })
}

/**
 * The scene a clip of the root belongs to: the one it plays most during, when it lasts no longer
 * than that scene. A line of voice-over belongs to the scene it is said over; a soundtrack under
 * every scene belongs to none.
 */
function sceneOfClip(root: VideoRoot, clip: VideoClip): VideoRoot["scenes"][number] | undefined {
  if (clip.durationMs === undefined) return undefined

  const clipEnd = clip.startMs + clip.durationMs
  let owner: VideoRoot["scenes"][number] | undefined
  let most = 0
  for (const scene of root.scenes) {
    const during =
      Math.min(clipEnd, scene.startMs + scene.durationMs) - Math.max(clip.startMs, scene.startMs)
    if (during > 0 && during >= most) {
      owner = scene
      most = during
    }
  }
  return owner && clip.durationMs <= owner.durationMs + SAME_MS ? owner : undefined
}

/**
 * Where the poster is once the scenes moved: as far into its scene as it was, the scene on top at
 * its instant, and within it; where it was without one. Past the end, the last frame.
 */
function posterAfter(before: VideoRoot, now: VideoRoot, duration: number): number | undefined {
  const posterMs = before.posterMs
  if (posterMs === undefined) return undefined

  const frame = Math.ceil(1000 / before.fps)
  const owner = before.scenes
    .filter((scene) => scene.startMs <= posterMs && posterMs < scene.startMs + scene.durationMs)
    .at(-1)
  const scene = owner && now.scenes.find((each) => each.id === owner.id)
  const at =
    owner && scene
      ? scene.startMs + Math.min(posterMs - owner.startMs, Math.max(0, scene.durationMs - frame))
      : posterMs
  return at >= duration ? Math.max(0, duration - frame) : at
}

/**
 * A scene file copied under a new id: its composition's id, its timeline's name, and the id of
 * every element, with what names it.
 */
function copySceneFile(text: string, from: string, to: string, taken: Set<string>): string {
  const quoted = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  let copy = text
    .replace(
      new RegExp(`(data-composition-id\\s*=\\s*)(["'])${quoted(from)}\\2`, "g"),
      (_, name, quote) => `${name}${quote}${to}${quote}`
    )
    .replace(
      new RegExp(`(__timelines\\s*\\[\\s*)(["'])${quoted(from)}\\2(\\s*\\])`, "g"),
      (_, open, quote, close) => `${open}${quote}${to}${quote}${close}`
    )

  // A copy goes on from nothing: the clip a part of it went on from is the original's.
  copy = copy.replace(/\s+data-continues\s*=\s*(["'])[^"']*\1/g, "")

  // Every element takes an id of its own, and whatever names it in the file follows, each read
  // once: the attribute, the look carried for it, a start chained to it by its whole name, and a
  // selector naming it, `#id` or `[id=…]`, in a style's preludes and a script's selector strings,
  // never a value, such as a colour `#fade`.
  const renamed = new Map<string, string>()
  for (const match of copy.matchAll(/\sid\s*=\s*(["'])([^"']+)\1/g)) {
    const id = match[2]
    if (!id || renamed.has(id)) continue
    const fresh = uniqueName(id, taken)
    taken.add(fresh)
    renamed.set(id, fresh)
  }
  if (renamed.size === 0) return copy
  const name = (id: string) => renamed.get(id) ?? id

  return copy
    .replace(
      /(\sid\s*=\s*)(["'])([^"']+)\2/g,
      (_, attribute, quote, id) => `${attribute}${quote}${name(id)}${quote}`
    )
    .replace(
      /(\sdata-start\s*=\s*(["'])\s*)([A-Za-z][\w.:-]*)(?=\s+[+-]\s|\s*\2)/g,
      (_, start, _quote, id) => `${start}${name(id)}`
    )
    .replace(
      /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
      (_, open, css, close) => `${open}${renameInCss(css, name)}${close}`
    )
    .replace(
      /(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi,
      (_, open, script, close) => `${open}${renameInScript(script, name)}${close}`
    )
}

/** A selector with each id it names, `#id` or `[id=…]`, named as `to` says. */
function renameInSelector(selector: string, to: (id: string) => string): string {
  return selector
    .replace(/#([A-Za-z_][\w-]*)/g, (_, id) => `#${to(id)}`)
    .replace(
      /(\[\s*id\s*=\s*)(["']?)([^"'\]\s]+)\2(\s*\])/g,
      (_, open, quote, id, close) => `${open}${quote}${to(id)}${quote}${close}`
    )
}

/**
 * A stylesheet with the ids its selectors name renamed, and nothing else: a rule's prelude and a
 * nested rule's are selectors; a declaration's value, an at-rule's prelude, a string and a comment
 * are not.
 */
function renameInCss(css: string, to: (id: string) => string): string {
  let out = ""
  let segment = ""
  for (let at = 0; at < css.length; at += 1) {
    const char = css[at] ?? ""
    if (char === "/" && css[at + 1] === "*") {
      const end = css.indexOf("*/", at + 2)
      const stop = end < 0 ? css.length : end + 2
      segment += css.slice(at, stop)
      at = stop - 1
      continue
    }
    if (char === '"' || char === "'") {
      let end = at + 1
      while (end < css.length && css[end] !== char) end += css[end] === "\\" ? 2 : 1
      segment += css.slice(at, end + 1)
      at = end
      continue
    }
    // What ends at a `{` is a prelude, a rule's or a nested one's; at a `;` or a `}`, a
    // declaration or a statement.
    if (char === "{") {
      out += segment.trimStart().startsWith("@") ? segment : renameInSelector(segment, to)
      out += char
      segment = ""
      continue
    }
    if (char === ";" || char === "}") {
      out += segment + char
      segment = ""
      continue
    }
    segment += char
  }
  return out + segment
}

/**
 * A script with the ids its selector strings name renamed, as `querySelector('#fade')` and
 * `\`${scene} #talk\``, and `getElementById`'s; a string that is a property's value, such as a
 * colour `{ color: "#fade" }`, is not a selector.
 */
function renameInScript(script: string, to: (id: string) => string): string {
  return script.replace(
    /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g,
    (whole, quote, inner, offset: number) => {
      const before = script.slice(Math.max(0, offset - 40), offset)
      if (/:\s*$/.test(before)) return whole
      if (/getElementById\(\s*$/.test(before)) return `${quote}${to(inner)}${quote}`
      return `${quote}${renameInSelector(inner, to)}${quote}`
    }
  )
}

/** Every name an id may not take: the scenes', and every element's id in every HTML file. */
function takenNames(work: Working): Set<string> {
  return new Set(nameCounts(work).keys())
}

/** How many times each id and each scene's name is written, in every HTML file. */
function nameCounts(work: Working): Map<string, number> {
  const counts = new Map<string, number>()
  for (const path of work.paths()) {
    if (!/\.html?$/i.test(path)) continue
    const text = work.text(path)
    for (const match of text.matchAll(/\s(?:id|data-composition-id)\s*=\s*(["'])([^"']*)\1/g)) {
      if (match[2]) counts.set(match[2], (counts.get(match[2]) ?? 0) + 1)
    }
  }
  return counts
}

/** `base`, or `base-2`, `base-3`… until one is not taken. */
function uniqueName(base: string, taken: ReadonlySet<string>): string {
  const stem = /^[A-Za-z]/.test(base) ? base : `x-${base}`
  const plain = stem.replace(/-\d+$/, "")
  // The id a carried look's rules weigh as is no element's.
  const free = (name: string) => !taken.has(name) && name !== LOOK_ID
  if (free(stem)) return stem
  for (let n = 2; ; n += 1) {
    const name = `${plain}-${n}`
    if (free(name)) return name
  }
}

function uniquePath(work: Working, stem: string, extension: string): string {
  if (!work.has(`${stem}${extension}`)) return `${stem}${extension}`
  for (let n = 2; ; n += 1) {
    if (!work.has(`${stem}-${n}${extension}`)) return `${stem}-${n}${extension}`
  }
}

/** A name an id may take: letters, digits and dashes, from a file's name. */
function slug(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^[^A-Za-z]+/, "")
    .replace(/-+$/, "")
    .slice(0, 40)
}

// Clips, inside -----------------------------------------------------------------------------------

function timelineOf(work: Working, file: string): VideoFileTimeline {
  const timeline = readTimeline(work, file)
  if (!timeline) throw new EditError(`${file} holds no composition.`)
  return timeline
}

/** A file's timeline, read once for each text it holds; none for a file holding no composition. */
function readTimeline(work: Working, file: string): VideoFileTimeline | null {
  const text = work.text(file)
  const read = work.timelines.get(file)
  if (read?.text === text) return read.timeline

  const timeline = readVideoFileTimeline(file, text)
  work.timelines.set(file, { text, timeline })
  return timeline
}

function clipOf(work: Working, file: string, target: VideoTarget): VideoClip {
  return resolveTarget(timelineOf(work, file).clips, target, file, "clip")
}

/**
 * The clips a group names, each once, as the files are before any of them changes: one gone, or
 * no longer alone like it, refuses the whole edit. `index` is its place among those named.
 */
function clipsOf(
  work: Working,
  clips: readonly VideoClipTarget[]
): { readonly file: string; readonly clip: VideoClip; readonly index: number }[] {
  if (clips.length === 0) throw new EditError("Choose the clips first.")

  const seen = new Set<string>()
  return clips.flatMap(({ file, clip }, index) => {
    const found = clipOf(work, file, clip)
    const key = `${file}\n${found.ref}`
    if (seen.has(key)) return []
    seen.add(key)
    return [{ file, clip: found, index }]
  })
}

/**
 * Clips by their file, `index.html` first: what an edit of the video's own moves, a scene's
 * edit then moves with its scene, as when each is edited alone.
 */
function byFile<T extends { readonly file: string }>(found: readonly T[]): Map<string, T[]> {
  const files = new Map<string, T[]>()
  const ordered = [...found].sort(
    (a, b) => Number(b.file === VIDEO_ENTRY) - Number(a.file === VIDEO_ENTRY)
  )
  for (const each of ordered) files.set(each.file, [...(files.get(each.file) ?? []), each])
  return files
}

/**
 * Splits a clip found in its file at `atMs` from its composition's start, and returns the second
 * part's id: see {@link splitClip}.
 */
function splitFound(
  work: Working,
  file: string,
  found: VideoClip,
  atMs: number,
  endMs: number | undefined
): string | undefined {
  const at = Math.round(atMs)
  const end = clipEnd(found, endMs)
  if (at - found.startMs < MIN_CLIP_MS || end - at < MIN_CLIP_MS) {
    throw new EditError(`Each part of a split clip lasts at least ${MIN_CLIP_MS} ms.`)
  }

  const parts = clipParts(work, file, found, [
    { startMs: found.startMs, mediaStartMs: found.mediaStartMs, durationMs: at - found.startMs },
    {
      startMs: at,
      mediaStartMs: found.mediaStartMs + (at - found.startMs),
      durationMs: end - at,
    },
  ])
  const second = parts.refs[1]
  replaceClip(work, file, found, parts.html)

  // What followed the clip's end follows the second part's, where that end now is.
  if (found.id && second) followInstead(work, file, found.id, second)
  return second
}

/**
 * Splits a clip as {@link splitFound} does, and when it goes on in later scenes, as two: the
 * second part heads the parts after it, which go on from it.
 */
function splitChained(
  work: Working,
  chains: ReadonlyMap<string, VideoChain>,
  file: string,
  found: VideoClip,
  atMs: number,
  endMs: number | undefined
): string | undefined {
  const chain = chains.get(`${file}\n${found.ref}`)
  const at = videoStartOf(work, file, found) - found.startMs + Math.round(atMs)
  const second = splitFound(work, file, found, atMs, endMs)
  if (!chain || !second) return second

  for (const part of chain.parts) {
    if ((part.file === file && part.clip.ref === found.ref) || part.startMs < at) continue
    const now = clipOf(work, part.file, videoTarget(part.clip))
    setAttributes(work, part.file, now.source, { "data-continues": second })
  }
  return second
}

/** The element a target names in a file, or why none is: see {@link findVideoTarget}. */
function resolveTarget<T extends { readonly ref: string; readonly tag: string }>(
  items: readonly T[],
  target: VideoTarget,
  file: string,
  what: "clip" | "text"
): T {
  const found = findVideoTarget(items, target)
  if (!Array.isArray(found)) return found as T

  const ref = typeof target === "string" ? target : target.ref
  if (typeof target === "string" || isIdRef(ref)) {
    throw new EditError(`${file} has no ${what} '${ref}'.`)
  }
  throw new EditError(
    found.length === 0
      ? `The ${what} you chose in ${file} changed or was removed meanwhile: choose it again.`
      : `${file} now has ${found.length} ${what}s like the one you chose: choose it again.`
  )
}

/**
 * The element a target names among a file's clips or texts, as the file is now: the one at its
 * place when it is still what the editor saw there, else the one element that is, wherever it
 * moved. Otherwise the elements alike, none or several: an edit refuses rather than land on
 * another element than the one the reader chose, and a selection lets go.
 */
export function findVideoTarget<T extends { readonly ref: string; readonly tag: string }>(
  items: readonly T[],
  target: VideoTarget
): T | readonly T[] {
  const ref = typeof target === "string" ? target : target.ref
  const placed = items.find((item) => item.ref === ref)
  if (typeof target === "string" || isIdRef(ref)) return placed ?? []

  if (placed && matches(placed, target)) return placed
  const alike = items.filter((item) => !isIdRef(item.ref) && matches(item, target))
  const [only] = alike
  return only && alike.length === 1 ? only : alike
}

/** Whether an element is still what the editor saw: its tag, words and file. */
function matches(
  item: { readonly tag: string; readonly text?: string; readonly src?: string },
  target: Exclude<VideoTarget, string>
): boolean {
  return (
    item.tag === target.tag &&
    (target.words === undefined || item.text === target.words) &&
    (target.src === undefined || item.src === target.src)
  )
}

/** Whether a ref is an element's own id, which no edit around it changes. */
function isIdRef(ref: string): boolean {
  return !/^#\d+$|^[a-z][\w-]*:\d+$/.test(ref)
}

function playsFile(clip: VideoClip): boolean {
  return clip.kind === "video" || clip.kind === "audio"
}

/** Where a clip ends: its length, else where its file or scene ends it, as `endMs` says. */
function clipEnd(clip: VideoClip, endMs: number | undefined): number {
  if (clip.durationMs !== undefined) return clip.startMs + clip.durationMs
  if (endMs !== undefined && endMs > clip.startMs) return Math.round(endMs)
  throw new EditError(`'${clip.ref}' writes no length: give it data-duration first.`)
}

/**
 * Moves what starts at `fromMs` or after by `deltaMs`, but the clips `except` names, and the
 * scene's end with it when it ends there or after: a gap closed or opened at `fromMs`.
 */
function ripple(
  work: Working,
  file: string,
  fromMs: number,
  deltaMs: number,
  except: ReadonlySet<string>
): void {
  if (deltaMs === 0) return

  const after = timelineOf(work, file).clips.filter(
    (clip) =>
      !except.has(clip.ref) && clip.startMs >= fromMs - SAME_MS && numericStart(work, file, clip)
  )
  rewriteClips(
    work,
    file,
    new Map(
      after.map((clip) => [
        clip.ref,
        { "data-start": seconds(Math.max(0, clip.startMs + deltaMs)) },
      ])
    )
  )

  const scene = sceneOf(work, file)
  if (scene && scene.durationMs >= fromMs - SAME_MS) {
    lengthenScene(work, scene.id, Math.max(MIN_CLIP_MS, scene.durationMs + deltaMs))
  }
}

/**
 * Takes stretches out of a composition's timeline: each clip moves back by what was cut before it
 * and loses what was cut of it. A recording cut through is split around the cut, each part
 * playing on from where its file was cut; another clip is only shortened, and one with nothing
 * left is removed. The scene ends as much sooner: by whole frame steps, as each stretch it shows
 * is made ({@link inFrameSteps}).
 */
function rippleRemove(work: Working, file: string, cut: readonly VideoCut[]): void {
  // The clips that go on, as they were before the operation cut any: what it leaves of them
  // goes on as one once it ends (see `marking`).
  work.marking ??= { chains: chainsOf(work), pieces: new Map() }
  const chains = work.marking
  const shown = sceneOf(work, file)
  const spans = shown
    ? inFrameSteps(cut, shown.durationMs, frameStepMs(rootOf(work).fps))
    : mergeRanges(cut)
  const map = (t: number) =>
    t - spans.reduce((sum, span) => sum + Math.max(0, Math.min(t, span.endMs) - span.startMs), 0)

  // A clip that follows one the cut moves, shortens or takes keeps the time it starts at, which
  // the cut then moves as any other's: its name may name a part, or nothing, once it is cut.
  const from = spans[0]?.startMs ?? Number.POSITIVE_INFINITY
  freezeFollowers(
    work,
    file,
    (each) => each.durationMs === undefined || each.startMs + each.durationMs > from
  )

  const taken = takenNames(work)
  const plan = new Map<string, ClipChange>()
  const chained = (clip: VideoClip) =>
    clip.id !== undefined && chains.chains.has(`${file}\n${clip.ref}`)
  for (const clip of timelineOf(work, file).clips) {
    if (!numericStart(work, file, clip)) continue

    const start = map(clip.startMs)
    if (clip.durationMs === undefined) {
      if (start !== clip.startMs) plan.set(clip.ref, { "data-start": seconds(start) })
      continue
    }

    // What is left of it, in the timeline before the cut.
    const kept = subtractRanges(
      { startMs: clip.startMs, endMs: clip.startMs + clip.durationMs },
      spans
    ).filter((piece) => piece.endMs - piece.startMs >= MIN_CLIP_MS)
    const first = kept[0]
    if (!first) {
      plan.set(clip.ref, "remove")
      if (chained(clip)) chains.pieces.set(`${file}\n${clip.ref}`, [])
      continue
    }

    if (playsFile(clip) && kept.length > 1) {
      const parts = clipParts(
        work,
        file,
        clip,
        kept.map((piece) => ({
          startMs: map(piece.startMs),
          mediaStartMs: clip.mediaStartMs + piece.startMs - clip.startMs,
          durationMs: piece.endMs - piece.startMs,
        })),
        taken
      )
      plan.set(clip.ref, { html: parts.html })
      if (chained(clip)) chains.pieces.set(`${file}\n${clip.ref}`, parts.refs)
      continue
    }

    const length = map(clip.startMs + clip.durationMs) - start
    if (start === clip.startMs && length === clip.durationMs) continue
    const into = first.startMs - clip.startMs
    plan.set(clip.ref, {
      "data-start": seconds(start),
      "data-duration": seconds(length),
      ...(into > 0 && playsFile(clip)
        ? { "data-media-start": seconds(clip.mediaStartMs + into) }
        : {}),
    })
  }
  rewriteClips(work, file, plan)
  pruneLooks(work, file)

  const scene = sceneOf(work, file)
  if (scene) lengthenScene(work, scene.id, Math.max(MIN_CLIP_MS, map(scene.durationMs)))
}

/**
 * Places again each clip that goes on whose parts its scenes, moved, now play at once, as a scene
 * removed between two that crossfade: placed again, from where it starts for as long as its parts
 * show, it goes on in the next scene where the one before ends, and is heard once.
 */
function settleChains(work: Working): void {
  joinStrays(work)

  // Each clip once: one placed again plays once, and leaves the others as they were.
  for (let placed = 0; ; placed += 1) {
    const scenes = rootOf(work).scenes
    const chains = chainsOf(work)
    if (placed > chains.size) return

    const overlapping = [...new Set(chains.values())].find((chain) => {
      const seen = chain.parts.map((part) => {
        const scene = scenes.find((each) => each.src === part.file)
        return Math.min(part.endMs, scene ? scene.startMs + scene.durationMs : part.endMs)
      })
      return chain.parts
        .slice(1)
        .some((part, at) => part.startMs < (seen[at] ?? part.startMs) - SAME_MS)
    })
    const head = overlapping?.parts[0]
    if (!head) return
    placeFound(work, [logicalClip(work, chains, head)])
  }
}

/**
 * Joins to its clip each part that goes on from that clip's last part but names another head, as
 * two people's edits merged may leave it, one cutting the clip's words and marking its pieces
 * again, the other placing it: such a part, and the parts that go on from it, name its head again.
 */
function joinStrays(work: Working): void {
  for (let joined = 0; joined <= MAX_STRAYS; joined += 1) {
    const scenes = rootOf(work).scenes
    const chains = [...new Set(chainsOf(work).values())]
    const linked = new Set(chains.flatMap((chain) => chain.parts.map((part) => keyOf(part))))

    // A clip whose head is gone, or a part that names one and goes on from nothing.
    const strays: VideoChainPart[][] = chains
      .filter((chain) => chain.parts[0]?.clip.continues)
      .map((chain) => [...chain.parts])
    for (const scene of scenes) {
      if (work.textOf(scene.src) === undefined) continue
      for (const clip of readTimeline(work, scene.src)?.clips ?? []) {
        const part = { file: scene.src, clip }
        if (!clip.continues || clip.durationMs === undefined || linked.has(keyOf(part))) continue
        const startMs = scene.startMs + clip.startMs
        strays.push([{ ...part, startMs, endMs: startMs + clip.durationMs }])
      }
    }

    const heads = chains.filter(
      (chain) => chain.parts[0]?.clip.id && !chain.parts[0].clip.continues
    )
    const found = strays
      .map((stray) => ({
        stray,
        chain: heads.find((chain) => {
          const last = chain.parts.at(-1)
          return last && stray[0] && goesOnFrom(scenes, last, stray[0])
        }),
      }))
      .find((each) => each.chain)
    const head = found?.chain?.parts[0]?.clip.id
    if (!found || !head) return

    for (const part of found.stray) {
      const now = clipOf(work, part.file, videoTarget(part.clip))
      setAttributes(work, part.file, now.source, { "data-continues": head })
    }
  }
}

/** Whether a file holds a part of a clip that goes on: one naming its head, or a head named. */
function holdsParts(work: Working, path: string): boolean {
  const text = work.textOf(path)
  if (path === VIDEO_ENTRY || text === undefined || !/\.html?$/i.test(path)) return false
  if (text.includes("data-continues")) return true

  const heads = new Set<string>()
  for (const file of work.paths()) {
    for (const match of (work.textOf(file) ?? "").matchAll(/\sdata-continues\s*=\s*"([^"]+)"/g)) {
      if (match[1]) heads.add(match[1])
    }
  }
  return [...heads].some((id) => text.includes(` id="${id}"`))
}

/** How many strays an edit joins again at most: two people's edits leave a few, never more. */
const MAX_STRAYS = 20

function keyOf(part: { readonly file: string; readonly clip: VideoClip }): string {
  return `${part.file}\n${part.clip.ref}`
}

/**
 * Marks again each clip that goes on that an operation cut: what is left of its parts, in play
 * order, goes on from the first piece left, its head. A cut through a part leaves pieces back to
 * back that go on one from the other; a part cut whole leaves none, and a head cut whole, the
 * next piece to head the rest.
 */
function markCutChains(work: Working): void {
  const marking = work.marking
  if (!marking || marking.pieces.size === 0) return

  for (const chain of new Set(marking.chains.values())) {
    const keys = chain.parts.map((part) => `${part.file}\n${part.clip.ref}`)
    if (!keys.some((key) => marking.pieces.has(key))) continue

    const left = chain.parts.flatMap((part, at) => {
      const ids = marking.pieces.get(keys[at] as string) ?? (part.clip.id ? [part.clip.id] : [])
      const clips = work.textOf(part.file) === undefined ? [] : timelineOf(work, part.file).clips
      return ids.flatMap((id) => {
        const clip = clips.find((each) => each.id === id)
        return clip ? [{ file: part.file, clip }] : []
      })
    })
    const [head, ...rest] = left
    if (!head?.clip.id) continue
    if (head.clip.continues) {
      setAttributes(work, head.file, head.clip.source, { "data-continues": null })
    }
    for (const part of rest) {
      if (part.clip.continues === head.clip.id) continue
      const now = clipOf(work, part.file, videoTarget(part.clip))
      setAttributes(work, part.file, now.source, { "data-continues": head.clip.id })
    }
  }
}

/**
 * The shortest stretch that is whole frames and whole milliseconds, which times are written in:
 * a frame at 25 and 50 fps, three at 24, 30 and 60 (125, 100 and 50 ms). A scene made longer or
 * shorter by steps moves those after it by whole frames: each still starts as far into its frame,
 * shows the same frames, and keeps its rendered segment.
 */
function frameStepMs(fps: number): number {
  let [a, b] = [fps, 1000]
  while (b > 0) [a, b] = [b, a % b]
  return 1000 / a
}

/**
 * Stretches cut from a scene `lengthMs` long, sorted and apart, each kept to what the scene shows
 * and grown to the whole steps that cover it, so nothing marked to go stays. What it grows by goes
 * into its room first, as evenly as each side has some, then evenly beyond, and always within
 * the scene. Two that come to touch are joined, and grown again.
 */
function inFrameSteps(cut: readonly VideoCut[], lengthMs: number, step: number): VideoRange[] {
  const scene = (ms: number) => Math.min(lengthMs, Math.max(0, ms))
  let spans = mergeCuts(
    cut.map((each) => {
      const room = each.room ?? each
      return {
        startMs: scene(Math.floor(each.startMs)),
        endMs: scene(Math.ceil(each.endMs)),
        room: { startMs: scene(Math.ceil(room.startMs)), endMs: scene(Math.floor(room.endMs)) },
      }
    })
  )

  for (;;) {
    const grown = mergeCuts(spans.map((span) => growToSteps(span, step, lengthMs)))
    if (grown.length === spans.length) return grown
    spans = grown
  }
}

/** A cut grown to the whole steps that cover it: into its room, then beyond, within `lengthMs`. */
function growToSteps(cut: VideoCut, step: number, lengthMs: number): VideoCut {
  const length = cut.endMs - cut.startMs
  const extra = Math.ceil(length / step) * step - length
  const room = cut.room ?? cut
  const roomBefore = Math.max(0, cut.startMs - room.startMs)
  const roomAfter = Math.max(0, room.endMs - cut.endMs)

  // Half each side, as far as its room goes; what one side lacks, the other takes.
  let before = Math.min(roomBefore, Math.floor(extra / 2))
  const after = Math.min(roomAfter, extra - before)
  before = Math.min(roomBefore, extra - after)

  // Past the room, half each side.
  const beyond = extra - before - after
  let startMs = cut.startMs - before - Math.floor(beyond / 2)
  let endMs = cut.endMs + after + Math.ceil(beyond / 2)

  // Within the scene: what would fall before it or after it goes on the other side.
  if (startMs < 0) [startMs, endMs] = [0, endMs - startMs]
  if (endMs > lengthMs) [startMs, endMs] = [Math.max(0, startMs - (endMs - lengthMs)), lengthMs]

  return {
    startMs,
    endMs,
    room: { startMs: Math.min(room.startMs, startMs), endMs: Math.max(room.endMs, endMs) },
  }
}

/** Cuts sorted, and those that touch or overlap joined, with the room of each. */
function mergeCuts(cuts: readonly VideoCut[]): VideoCut[] {
  const sorted = cuts.filter((cut) => cut.endMs > cut.startMs).sort((a, b) => a.startMs - b.startMs)

  const merged: VideoCut[] = []
  for (const cut of sorted) {
    const room = cut.room ?? cut
    const last = merged.at(-1)
    if (last && cut.startMs <= last.endMs) {
      const lastRoom = last.room ?? last
      merged[merged.length - 1] = {
        startMs: last.startMs,
        endMs: Math.max(last.endMs, cut.endMs),
        room: {
          startMs: Math.min(lastRoom.startMs, room.startMs),
          endMs: Math.max(lastRoom.endMs, room.endMs),
        },
      }
    } else {
      merged.push({ startMs: cut.startMs, endMs: cut.endMs, room })
    }
  }
  return merged
}

/** A range without the spans, sorted and apart: what is left of it, in pieces. */
function subtractRanges(range: VideoRange, spans: readonly VideoRange[]): VideoRange[] {
  const pieces: VideoRange[] = []
  let cursor = range.startMs
  for (const span of spans) {
    if (span.endMs <= cursor || span.startMs >= range.endMs) continue
    if (span.startMs > cursor) pieces.push({ startMs: cursor, endMs: span.startMs })
    cursor = Math.max(cursor, span.endMs)
  }
  if (cursor < range.endMs) pieces.push({ startMs: cursor, endMs: range.endMs })
  return pieces
}

/** Whether a clip's start is written as seconds, which a ripple moves; a named one follows its clip. */
function numericStart(work: Working, file: string, clip: VideoClip): boolean {
  const at = clip.source.attributes["data-start"]
  if (!at) return true
  return Number.isFinite(Number(attributeValue(work.text(file), at) ?? Number.NaN))
}

/** The clip a written start follows, by its name, and what comes after: `v` and ` + 0.5`. */
function followed(written: string): { readonly name: string; readonly offset: string } | undefined {
  if (written.trim() === "" || Number.isFinite(Number(written))) return undefined
  const match = /^\s*(.*?)(\s*[+-]\s*(?:\d*\.)?\d+)?\s*$/.exec(written)
  return match?.[1] ? { name: match[1], offset: match[2] ?? "" } : undefined
}

/**
 * Writes the start of each clip that follows one `moves` picks as the seconds it starts at now:
 * once what it follows is moved, split or gone, it starts where it did. One at a time, each read
 * again, as each write moves what comes after it in the file.
 */
function freezeFollowers(work: Working, file: string, moves: (clip: VideoClip) => boolean): void {
  for (;;) {
    const clips = timelineOf(work, file).clips
    const moving = new Set(clips.flatMap((clip) => (clip.id && moves(clip) ? [clip.id] : [])))
    const follower = clips.find((clip) => {
      const at = clip.source.attributes["data-start"]
      const name = at ? followed(attributeValue(work.text(file), at) ?? "")?.name : undefined
      return name !== undefined && moving.has(name)
    })
    if (!follower) return

    setAttributes(work, file, follower.source, { "data-start": seconds(follower.startMs) })
  }
}

/** Points each clip that follows `name` to `instead`, with its own offset. */
function followInstead(work: Working, file: string, name: string, instead: string): void {
  for (;;) {
    const follower = timelineOf(work, file).clips.find((clip) => {
      const at = clip.source.attributes["data-start"]
      return at && followed(attributeValue(work.text(file), at) ?? "")?.name === name
    })
    const at = follower?.source.attributes["data-start"]
    if (!follower || !at) return

    const written = followed(attributeValue(work.text(file), at) ?? "")
    setAttributes(work, file, follower.source, {
      "data-start": `${instead}${written?.offset ?? ""}`,
    })
  }
}

/** What becomes of a clip: attributes set, removed, or written again as other HTML. */
type ClipChange = Readonly<Record<string, string | null>> | "remove" | { readonly html: string }

/** Changes clips of one file, read once, from the last to the first. */
function rewriteClips(work: Working, file: string, plan: ReadonlyMap<string, ClipChange>): void {
  if (plan.size === 0) return

  const clips = timelineOf(work, file)
    .clips.filter((clip) => plan.has(clip.ref))
    .sort((a, b) => b.source.element.start - a.source.element.start)
  for (const clip of clips) {
    const change = plan.get(clip.ref)
    if (change === "remove") {
      const block = lineBlock(work.text(file), clip.source.element)
      work.replace(file, block.start, block.end, "")
    } else if (change && "html" in change && typeof change.html === "string") {
      work.replace(file, clip.source.element.start, clip.source.element.end, change.html)
    } else if (change) {
      setAttributes(work, file, clip.source, change as Readonly<Record<string, string | null>>)
    }
  }
}

/**
 * The HTML of a clip's parts, each a copy of it with its own timing: the first keeps its id, the
 * others take new ones, so HyperFrames plays each.
 */
function clipParts(
  work: Working,
  file: string,
  clip: VideoClip,
  parts: readonly {
    readonly startMs: number
    readonly mediaStartMs: number
    readonly durationMs: number
  }[],
  taken: Set<string> = takenNames(work)
): { readonly html: string; readonly refs: readonly string[] } {
  const text = work.text(file)
  const element = text.slice(clip.source.element.start, clip.source.element.end)
  const indent = lineIndent(text, clip.source.element.start)
  const base = clip.id ?? slug(clip.src?.replace(/^.*\//, "").replace(/\.[^.]*$/, "") ?? "")

  const refs: string[] = []
  const html = parts.map((part, index) => {
    const id = index === 0 && clip.id ? clip.id : uniqueName(base || clip.kind, taken)
    taken.add(id)
    refs.push(id)
    return withAttributes(element, {
      id,
      "data-start": seconds(part.startMs),
      "data-duration": seconds(part.durationMs),
      ...(playsFile(clip) ? { "data-media-start": seconds(part.mediaStartMs) } : {}),
      // Only the first piece goes on from the clip the whole did.
      ...(index === 0 ? {} : { "data-continues": null }),
    })
  })
  return { html: html.join(`\n${indent}`), refs }
}

function replaceClip(work: Working, file: string, clip: VideoClip, html: string): void {
  work.replace(file, clip.source.element.start, clip.source.element.end, html)
}

/** A new clip's element, as the Agent's guide writes one. */
function clipHtml(
  kind: VideoImportKind,
  values: {
    readonly id: string
    readonly src: string
    readonly start: string
    readonly duration: string
    readonly mediaStart: string
    /** Footage whose sound is not played. */
    readonly muted?: boolean
  }
): string {
  const { id, src, start, duration, mediaStart } = values
  const fill = 'style="position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover"'
  const timing = `data-start="${start}" data-duration="${duration}"`
  const sound = values.muted ? "muted" : 'data-has-audio="true"'
  switch (kind) {
    case "video":
      return `<video id="${id}" src="${escapeAttribute(src)}" ${timing} data-media-start="${mediaStart}" ${sound} playsinline ${fill}></video>`
    case "audio":
      return `<audio id="${id}" src="${escapeAttribute(src)}" ${timing} data-media-start="${mediaStart}" data-volume="1"></audio>`
    case "image":
      return `<img id="${id}" src="${escapeAttribute(src)}" alt="" ${timing} ${fill}>`
  }
}

/**
 * Puts clips' elements in a composition, on lines of their own, as children of the composition
 * itself: never inside one of its elements, a phone's frame or a lower third, whose look would be
 * theirs. A picture goes under the words: before the first element holding any, when that one
 * comes no later than the last holding a picture, as a card holding both; else after the last
 * holding a picture. Words and sounds go after the last element holding one of their track, else
 * over the pictures, after the last holding one; else last, before the closing styles and scripts.
 */
function insertInComposition(
  work: Working,
  file: string,
  timeline: VideoFileTimeline,
  elements: readonly string[],
  track: VideoTrack
): void {
  const text = work.text(file)
  const children = timeline.children
  const holds = (child: (typeof children)[number], tracks: readonly VideoTrack[]) => {
    const { start, end } = child.source.element
    const inside = (span: VideoSourceSpan) => span.start >= start && span.end <= end
    return (
      timeline.clips.some((clip) => tracks.includes(clip.track) && inside(clip.source.element)) ||
      (tracks.includes("text") && timeline.texts.some((each) => inside(each.source.element)))
    )
  }
  const lastHolding = (tracks: readonly VideoTrack[]) =>
    children.filter((child) => holds(child, tracks)).at(-1)

  // A picture never goes over words: before the first element holding any, when that one comes
  // no later than the last holding a picture, as a card holding both.
  const firstWords = children.findIndex((child) => holds(child, ["text"]))
  const lastPicture = children.reduce(
    (last, child, index) => (holds(child, ["picture"]) ? index : last),
    -1
  )
  const underWords =
    track === "picture" && firstWords >= 0 && (lastPicture < 0 || firstWords <= lastPicture)
  const after = underWords
    ? undefined
    : (lastHolding([track]) ?? (track === "picture" ? undefined : lastHolding(["picture"])))
  const before = underWords ? children[firstWords] : undefined
  // Last, before the styles and scripts that close the composition.
  let closing = children.length
  while (closing > 0 && ["style", "script"].includes(children[closing - 1]?.tag ?? "")) closing -= 1
  const next = before ?? (after ? undefined : children[closing])
  const previous = after ?? (next ? undefined : children[closing - 1])

  if (previous) {
    const block = lineBlock(text, previous.source.element)
    const indent = lineIndent(text, previous.source.element.start)
    const html = elements.join(`\n${indent}`)
    work.replace(file, block.end, block.end, `${indent}${html}${lineEnd(text, block)}`)
    return
  }

  if (next) {
    const block = lineBlock(text, next.source.element)
    const indent = lineIndent(text, next.source.element.start)
    const html = elements.join(`\n${indent}`)
    if (block.start < next.source.element.start || aloneOnLine(text, next.source.element.start)) {
      work.replace(file, block.start, block.start, `${indent}${html}\n`)
    } else {
      work.replace(file, next.source.element.start, next.source.element.start, `${html} `)
    }
    return
  }

  const content = timeline.composition.content
  if (!content) throw new EditError(`${file}: its composition holds nothing a clip can join.`)
  const indent = `${lineIndent(text, timeline.composition.element.start)}  `
  work.replace(file, content.start, content.start, `\n${indent}${elements.join(`\n${indent}`)}`)
}

// Placing clips ----------------------------------------------------------------------------------

/** Where a placement put each clip, as {@link VideoPlaceResult} says. */
interface Placement {
  readonly clips: readonly VideoClipTarget[]
  readonly animationsLeft: readonly VideoAnimationLeft[]
  readonly animationsJoined?: readonly VideoAnimationJoined[]
  readonly looksMayDiffer?: readonly VideoClipTarget[]
}

/** A clip found in its file, and where in the video it is to play. */
interface Placing {
  readonly file: string
  readonly clip: VideoClip
  /** From the video's start. */
  readonly startMs: number
  /** How long it plays; none for a clip that writes no length, which plays until its scene ends. */
  readonly durationMs: number | undefined
  /** Where in its file it starts playing, when not where it does now: a start trimmed. */
  readonly mediaStartMs?: number
  /**
   * Where a recording cut by its words skips on in its file, by how far into the clip: from each,
   * it plays on from there. None for one that plays its file straight on.
   */
  readonly jumps?: readonly MediaJump[]
  /** The parts it goes on in, in later scenes: each used again where one lands, else removed. */
  readonly others?: readonly { readonly file: string; readonly clip: VideoClip }[]
}

/** Where a recording skips on in its file: from `intoMs` into the clip, it plays from `mediaMs`. */
interface MediaJump {
  readonly intoMs: number
  readonly mediaMs: number
}

type Scene = VideoRoot["scenes"][number]

/** A stretch of a placed clip, in the scene that plays it, from `startMs` in the video. */
interface Part {
  readonly scene: Scene
  readonly startMs: number
  readonly durationMs: number | undefined
  /** How far into the clip it starts: what the parts before it play. */
  readonly intoMs: number
}

/**
 * Marks each clip a placement writes, the first part of each wherever it lands, until the
 * placement reads where each ended up. Added and removed within one edit, it is never in one.
 */
const PLACING = "data-sixb-placing"

/** Where a clip of a file starts in the video: its scene's start and its own. */
function videoStartOf(work: Working, file: string, clip: VideoClip): number {
  return (sceneOf(work, file)?.startMs ?? 0) + clip.startMs
}

/**
 * Moves clips found in their files by `deltaMs`, as one placement: none before the video's start,
 * so the whole group moves less. Each keeps the length its scene shows of it: what played on past
 * the scene's end, never seen, stays behind rather than show in the next scene.
 */
function moveFound(
  work: Working,
  found: readonly { readonly file: string; readonly clip: VideoClip }[],
  deltaMs: number
): Placement {
  const chains = chainsOf(work)
  const logical = [
    ...new Map(
      found.map((each) => {
        const clip = logicalClip(work, chains, each)
        return [`${clip.file}\n${clip.clip.ref}`, clip] as const
      })
    ).values(),
  ]
  const delta = Math.max(Math.round(deltaMs), ...logical.map((clip) => -clip.startMs))

  // A move that goes nowhere, as a group held at the video's start, changes nothing.
  if (delta === 0) {
    return {
      clips: logical.map(({ file, clip }) => ({ file, clip: videoTarget(clip) })),
      animationsLeft: [],
      animationsJoined: [],
    }
  }

  return placeFound(
    work,
    logical.map((clip) => ({ ...clip, startMs: clip.startMs + delta }))
  )
}

/** The chains of the video's scenes, each by every part of it, as `file\nref`. */
function chainsOf(work: Working): Map<string, VideoChain> {
  const scenes = rootOf(work).scenes
  const chains = videoChains(scenes, (file) =>
    work.textOf(file) === undefined ? undefined : (readTimeline(work, file) ?? undefined)
  )
  const byPart = new Map<string, VideoChain>()
  for (const chain of chains) {
    for (const part of chain.parts) byPart.set(`${part.file}\n${part.clip.ref}`, chain)
  }
  return byPart
}

/**
 * A clip as one, whatever part of it is named: its head, where it starts in the video, how long
 * it plays as its scenes show it, and the parts it goes on in. What played on past the last
 * part's scene's end, never seen, is not part of it.
 */
function logicalClip(
  work: Working,
  chains: ReadonlyMap<string, VideoChain>,
  found: { readonly file: string; readonly clip: VideoClip }
): Placing {
  const chain = chains.get(`${found.file}\n${found.clip.ref}`)
  const [head, ...others] = chain?.parts ?? [
    { ...found, startMs: videoStartOf(work, found.file, found.clip), endMs: 0 },
  ]
  if (!head) throw new EditError(`'${found.clip.ref}' is not one of the video's clips.`)

  // As long as its scenes show it: each part to its scene's end, a part past it, unseen, as it
  // is. A clip that goes on lasts as long as its parts show, so placed again it plays its file on
  // without the gap or the hidden end a scene made longer or shorter under it left.
  const shown = (part: { readonly file: string; readonly clip: VideoClip }) => {
    if (part.clip.durationMs === undefined) return undefined
    const scene = sceneOf(work, part.file)
    if (!scene || part.clip.startMs >= scene.durationMs) return part.clip.durationMs
    return Math.min(part.clip.durationMs, scene.durationMs - part.clip.startMs)
  }
  const lengths = [head, ...others].map(shown)
  const durationMs = lengths.some((length) => length === undefined)
    ? undefined
    : lengths.reduce<number>((sum, length) => sum + (length ?? 0), 0)

  // Where a part plays on from where the one before stops, as written, it is that one played on,
  // whatever its scene hides or leaves; elsewhere, its words were cut, and it skips on there.
  const jumps: MediaJump[] = []
  if (playsFile(head.clip)) {
    let intoMs = 0
    others.forEach((part, at) => {
      const before = [head, ...others][at] as typeof part
      intoMs += lengths[at] ?? 0
      const stops = before.clip.mediaStartMs + (before.clip.durationMs ?? 0)
      if (Math.abs(part.clip.mediaStartMs - stops) > SAME_MS) {
        jumps.push({ intoMs, mediaMs: part.clip.mediaStartMs })
      }
    })
  }
  return {
    file: head.file,
    clip: head.clip,
    startMs: head.startMs,
    durationMs,
    ...(jumps.length > 0 ? { jumps } : {}),
    others: others.map(({ file, clip }) => ({ file, clip })),
  }
}

/**
 * Where a clip placed from `mediaStartMs` plays its file `intoMs` into it: on from its start, or
 * from the last jump before that point.
 */
function mediaAt(
  mediaStartMs: number,
  jumps: readonly MediaJump[] | undefined,
  intoMs: number
): number {
  const jump = jumps?.filter((each) => each.intoMs <= intoMs).at(-1)
  return jump ? jump.mediaMs + intoMs - jump.intoMs : mediaStartMs + intoMs
}

/**
 * The jumps of a clip whose start moves `byMs` into it, or back out: each as far into the clip
 * as it is now, those it passes behind it, and where it then starts in its file.
 */
function jumpsFrom(
  mediaStartMs: number,
  jumps: readonly MediaJump[] | undefined,
  byMs: number
): { readonly mediaStartMs: number; readonly jumps?: readonly MediaJump[] } {
  if (!jumps) return { mediaStartMs: mediaStartMs + byMs }
  const ahead = jumps
    .filter((jump) => jump.intoMs > byMs)
    .map((jump) => ({ intoMs: jump.intoMs - byMs, mediaMs: jump.mediaMs }))
  return {
    mediaStartMs: byMs < 0 ? mediaStartMs + byMs : mediaAt(mediaStartMs, jumps, byMs),
    ...(ahead.length > 0 ? { jumps: ahead } : {}),
  }
}

/**
 * Puts clips where they are to play in the video, as one step: each clip of a scene in the scene
 * that plays where it starts, its own while that holds it, and on past that scene's end as a copy
 * in the next (see {@link partsOf}); the last scene grows, in whole frame steps, to hold what
 * lands past it. The video's own clips only take their times. A clip that leaves its file takes
 * an id no other element of the video has, its styles and its recording's path; what followed it
 * there keeps its time. Every clip is found before any changes.
 */
function placeFound(work: Working, placing: readonly Placing[]): Placement {
  // Every scene read once: `partsOf` tells them apart by identity.
  const root = rootOf(work)
  const scenes = root.scenes
  const frameMs = 1000 / root.fps
  const plans = placing.map((each, index) => {
    const own =
      each.file === VIDEO_ENTRY ? undefined : scenes.find((scene) => scene.src === each.file)
    const parts = own
      ? atJumps(partsOf(scenes, own, each.startMs, each.durationMs), each, frameMs)
      : []
    return { ...each, index, own, parts }
  })

  // A clip leaves its file whole or not at all, and only for a file one scene plays.
  const read = new Map<string, readonly VideoClip[]>()
  const clipsIn = (file: string) => {
    const known = read.get(file)
    if (known) return known
    const clips = timelineOf(work, file).clips
    read.set(file, clips)
    return clips
  }
  for (const { file, clip, own, parts } of plans) {
    if (!own || parts.every((part) => part.scene.id === own.id)) continue

    for (const src of new Set([file, ...parts.map((part) => part.scene.src)])) {
      if (scenes.filter((scene) => scene.src === src).length > 1) {
        throw new EditError(`More than one scene plays ${src}: a clip can't leave or join it.`)
      }
    }
    const { start, end } = clip.source.element
    const holds = clipsIn(file).some(
      (other) => other.source.element.start > start && other.source.element.end <= end
    )
    if (holds) throw new EditError(`'${clip.ref}' holds other clips: it moves within its scene.`)
  }

  // Each clip marked, from the last in each file, so the spans read once still name what they did.
  for (const [file, each] of byFile(plans)) {
    const marks = new Map(each.map((plan) => [plan.clip.ref, String(plan.index)]))
    const clips = timelineOf(work, file)
      .clips.filter((clip) => marks.has(clip.ref))
      .sort((a, b) => b.source.element.start - a.source.element.start)
    for (const clip of clips) {
      setAttributes(work, file, clip.source, { [PLACING]: marks.get(clip.ref) ?? null })
    }
  }

  // What followed a clip that leaves, or now ends sooner in its file, or a part of one that may
  // go, keeps its time.
  const cut = new Map<string, Set<string>>()
  const cuts = (file: string, id: string | undefined) => {
    if (!id) return
    cut.set(file, (cut.get(file) ?? new Set()).add(id))
  }
  for (const { file, clip, own, parts, durationMs, others } of plans) {
    const [first] = parts
    const whole =
      parts.length === 1 && first?.scene.id === own?.id && first?.durationMs === durationMs
    if (own && !whole) cuts(file, clip.id)
    for (const other of others ?? []) cuts(other.file, other.clip.id)
  }
  for (const [file, ids] of cut) {
    freezeFollowers(work, file, (clip) => clip.id !== undefined && ids.has(clip.id))
  }

  // Each file's clips written in place or taken out, and what lands in another file kept for it.
  // Every file is read before any is written, so each clip's ref still names it.
  const counts = nameCounts(work)
  const taken = new Set(counts.keys())
  const carried: Carried[] = []
  const left: { readonly index: number; readonly scene: string }[] = []
  const joined: { readonly index: number; readonly scene: string }[] = []
  const uncertain = new Set<number>()
  const changes = new Map<string, Map<string, ClipChange>>()
  const change = (file: string, ref: string, what: ClipChange) => {
    const plan = changes.get(file) ?? new Map<string, ClipChange>()
    changes.set(file, plan)
    plan.set(ref, what)
  }
  // The files whose looks may have lost their last clip, the sheets every scene reads, and each
  // look worked out once: by its file's styles, and by what the clip is as a selector reads it.
  const touched = new Set<string>()
  const linked = linkedBlocks(work)
  const blocksOf = new Map<string, readonly CssBlock[]>()
  const parsed = (css: string) => {
    const known = blocksOf.get(css)
    if (known) return known
    const blocks = cssBlocks(css)
    blocksOf.set(css, blocks)
    return blocks
  }
  const looksOf = new Map<string, { look: Look; home: string }>()
  // What holds a clip landing in each scene, read once for all that land there.
  const contexts = new Map<string, LookContext>()
  const landing = (id: string) => {
    const known = contexts.get(id)
    if (known) return known
    // The scene as the files are now, which what is written in them may have moved.
    const scene = rootOf(work).scenes.find((each) => each.id === id)
    const context = scene ? sceneContext(work, scene) : undefined
    if (context) contexts.set(id, context)
    return context
  }
  // The parts each clip placed goes on in, as `file\nid`, by the ids its parts may name.
  const wrote = new Map<string, Set<string>>()

  for (const [file, each] of byFile(plans)) {
    const text = work.text(file)
    const clips = timelineOf(work, file).clips
    const scripts = file === VIDEO_ENTRY ? "" : scriptsOf(text)
    const read = attributesRead([...linked, ...stylesIn(text).map((style) => parsed(style.css))])

    for (const plan of each) {
      const { clip: was, own, parts, startMs, durationMs, index } = plan
      const clip = markedClip(text, clips, index)

      if (!own) {
        change(file, clip.ref, {
          ...(startMs === was.startMs ? {} : { "data-start": seconds(startMs) }),
          ...(durationMs === undefined || durationMs === was.durationMs
            ? {}
            : { "data-duration": seconds(durationMs) }),
        })
        continue
      }

      const element = text.slice(clip.source.element.start, clip.source.element.end)
      const facts = lookElement(element, was.id)
      const stays = parts[0]?.scene.id === own.id
      const mediaStartMs = plan.mediaStartMs ?? was.mediaStartMs
      // How it looks where it is, for each part that lands elsewhere: its scene is its home,
      // unless it came with a look carried from another, which it keeps by its key.
      const carriedKey = facts.attributes.get("data-look")
      const known = parts.some((part) => part.scene.id !== own.id)
        ? (() => {
            const signature = `${file}\n${carriedKey ?? ""}\n${lookSignature(facts, read)}`
            const cached = looksOf.get(signature)
            if (cached) return cached
            const styled = lookSheets(stylesIn(text), carriedKey, linked, parsed)
            const found = {
              look: lookOf(facts, own.id, styled.sheets),
              home: styled.home ?? own.id,
            }
            looksOf.set(signature, found)
            return found
          })()
        : undefined
      const look = known?.look
      const home = known?.home ?? own.id
      const key = look && look.rules.length > 0 ? lookKey(home, look) : undefined
      // It may look otherwise only where what it could not take along styles it otherwise.
      if (look?.uncertain) {
        const from = clipContext(work, own, text, clip)
        const elsewhere = new Set(
          parts.map((part) => part.scene).filter((scene) => scene.id !== home)
        )
        const differs = [...elsewhere].some((scene) =>
          lookDiffers(look, facts, { from, to: landing(scene.id) ?? [] })
        )
        if (differs) uncertain.add(index)
      }
      const base = was.id ?? slug(was.src?.replace(/^.*\//, "").replace(/\.[^.]*$/, "") ?? "")
      const fresh = () => {
        const id = uniqueName(base || was.kind, taken)
        taken.add(id)
        return id
      }

      // Its parts in later scenes, each used again where a new one lands in its file.
      const others = [...(plan.others ?? [])]
      const reuse = (src: string) => {
        const at = others.findIndex((other) => other.file === src)
        return at < 0 ? undefined : others.splice(at, 1)[0]
      }

      // The head: in place, or written for the file it lands in. It has an id once parts go on
      // from it, and its own id unless another element has it.
      const keepsId = was.id !== undefined && (stays || (counts.get(was.id) ?? 0) <= 1)
      const headId = keepsId ? was.id : was.id || parts.length > 1 ? fresh() : undefined
      if (headId && headId === was.id) taken.add(headId)
      const written = new Set<string>()
      for (const id of [headId, was.id]) if (id) wrote.set(id, written)

      // As one clip, it fades in on its first part and out on its last: the fade out it ended on.
      const lastOther = plan.others?.at(-1)
      const fadeOutMs = lastOther ? lastOther.clip.fadeOutMs : was.fadeOutMs
      const fades = (n: number, now: VideoClip): Record<string, string | null> => ({
        ...(n > 0 && now.fadeInMs !== undefined ? { "data-fade-in": null } : {}),
        ...(n < parts.length - 1
          ? now.fadeOutMs === undefined
            ? {}
            : { "data-fade-out": null }
          : now.fadeOutMs === fadeOutMs
            ? {}
            : { "data-fade-out": fadeOutMs === undefined ? null : seconds(fadeOutMs) }),
      })

      parts.forEach((part, n) => {
        const media = mediaAt(mediaStartMs, plan.jumps, part.intoMs)
        const timing = {
          start: seconds(part.startMs - part.scene.startMs),
          duration: part.durationMs === undefined ? undefined : seconds(part.durationMs),
          media: playsFile(was) ? seconds(media) : undefined,
        }

        if (n === 0 && stays) {
          change(file, clip.ref, {
            ...(part.startMs === own.startMs + was.startMs ? {} : { "data-start": timing.start }),
            ...(timing.duration === undefined || part.durationMs === was.durationMs
              ? {}
              : { "data-duration": timing.duration }),
            ...(timing.media === undefined || mediaStartMs === was.mediaStartMs
              ? {}
              : { "data-media-start": timing.media }),
            ...(headId && headId !== was.id ? { id: headId } : {}),
            ...(was.continues ? { "data-continues": null } : {}),
            ...fades(n, was),
          })
          return
        }

        // A part that goes on, in a file holding one already: that one, written again.
        const kept = n > 0 ? reuse(part.scene.src) : undefined
        if (kept) {
          const old = kept.clip
          written.add(`${kept.file}\n${old.id ?? old.ref}`)
          change(kept.file, old.ref, {
            ...(part.startMs - part.scene.startMs === old.startMs
              ? {}
              : { "data-start": timing.start }),
            ...(part.durationMs === old.durationMs || timing.duration === undefined
              ? {}
              : { "data-duration": timing.duration }),
            ...(timing.media === undefined || media === old.mediaStartMs
              ? {}
              : { "data-media-start": timing.media }),
            ...(old.continues === headId ? {} : { "data-continues": headId ?? null }),
            ...fades(n, old),
          })
          return
        }

        const id = n === 0 ? headId : fresh()
        if (n > 0 && id) written.add(`${part.scene.src}\n${id}`)
        // Its look, by its key, where it is not at home; at home, its scene's own rules.
        const styled = key !== undefined && part.scene.id !== home
        const src = attributeOf(text, clip, "src")
        const moved = src === undefined ? undefined : rebased(work, file, part.scene.src, src)
        const html = withAttributes(element, {
          ...(id ? { id } : {}),
          "data-start": timing.start,
          ...(timing.duration === undefined ? {} : { "data-duration": timing.duration }),
          // Where it plays its file from, written only where that changes.
          ...(timing.media === undefined || media === was.mediaStartMs
            ? {}
            : { "data-media-start": timing.media }),
          ...(moved === undefined ? {} : { src: moved }),
          "data-continues": n === 0 ? null : (headId ?? null),
          "data-look": styled ? key : null,
          ...fades(n, was),
          ...(n === 0 ? {} : { [PLACING]: null }),
        })
        carried.push({
          file: part.scene.src,
          scene: part.scene.id,
          track: was.track,
          html,
          index,
          element: { ...facts, ...(id ? { id } : {}) },
          ...(look && key && styled ? { look, key, home } : {}),
        })
      })

      if (!stays) {
        change(file, clip.ref, "remove")
        touched.add(file)
        if (scriptNames(scripts, facts)) left.push({ index, scene: own.id })
      }

      // The parts no new one lands beside go, with the looks they carried.
      for (const other of others) {
        change(other.file, other.clip.ref, "remove")
        touched.add(other.file)
      }
    }
  }

  for (const [file, plan] of changes) rewriteClips(work, file, plan)

  // What lands in a file goes after the last clip of its track there, in the order placed.
  for (const [file, each] of groupBy(carried, (one) => one.file)) {
    for (const track of ["picture", "text", "sound"] as const) {
      const batch = each.filter((one) => one.track === track)
      if (batch.length === 0) continue

      insertInComposition(
        work,
        file,
        timelineOf(work, file),
        batch.map((one) => one.html),
        track
      )
    }

    // Each look that came with a clip, in a style of its own that reaches that clip alone, and
    // each animation of this scene that reaches what landed.
    const scripts = scriptsOf(work.text(file))
    const seen = sceneKeyframes(work, file, linked)
    const carriedIn = new Map(seen.carried)
    const text = work.text(file)
    const present = lookBlocks(text)
    const written = new Set(present.map((block) => block.key))
    const looks: { readonly key: string; readonly home: string; readonly rules: string[] }[] = []
    for (const one of each) {
      // A look the file writes already goes in the edit whole all the same: someone removing it
      // at once, its last clip gone, leaves this one's for the clip it brings.
      const there = one.key ? present.find((block) => block.key === one.key) : undefined
      if (there) work.writeWhole(file, text.slice(...spanOf(lineBlock(text, there))))

      if (one.look && one.key && one.home && !written.has(one.key)) {
        written.add(one.key)
        const rules = writtenLook(one.look, one.scene, one.key, {
          own: seen.own,
          carried: carriedIn,
        })
        if (rules.length > 0) looks.push({ key: one.key, home: one.home, rules })
        // What it wrote, the next look reads.
        for (const [name, body] of keyframesOf(cssBlocks(rules.join("\n")))) {
          carriedIn.set(name, [...(carriedIn.get(name) ?? []), body])
        }
      }
      const context = landing(one.scene)
      const reaches = context
        ? scriptReachesIn(scripts, one.element, context)
        : scriptReaches(scripts, one.element)
      if (reaches && !joined.some((each) => each.index === one.index)) {
        joined.push({ index: one.index, scene: one.scene })
      }
    }
    writeLooks(work, file, looks)
  }
  for (const file of touched) pruneLooks(work, file)

  // Whatever else names a clip placed, a part some edit left out of it, lets go of it: it is
  // a clip of its own, and no later placement links it again.
  if (wrote.size > 0) {
    for (const scene of rootOf(work).scenes) {
      const text = work.textOf(scene.src)
      if (text === undefined || !text.includes("data-continues")) continue
      for (;;) {
        const stale = readTimeline(work, scene.src)?.clips.find((clip) => {
          const parts = clip.continues ? wrote.get(clip.continues) : undefined
          return parts !== undefined && !parts.has(`${scene.src}\n${clip.id ?? clip.ref}`)
        })
        if (!stale) break
        setAttributes(work, scene.src, stale.source, { "data-continues": null })
      }
    }
  }

  // The last scene grows to hold what lands past its end.
  const needed = new Map<string, number>()
  for (const { parts } of plans) {
    for (const part of parts) {
      if (part.durationMs === undefined) continue
      const end = part.startMs + part.durationMs - part.scene.startMs
      needed.set(part.scene.id, Math.max(needed.get(part.scene.id) ?? 0, end))
    }
  }
  const step = frameStepMs(rootOf(work).fps)
  for (const [id, end] of needed) {
    const scene = scenes.find((each) => each.id === id)
    if (scene && end > scene.durationMs + SAME_MS) {
      lengthenScene(work, id, Math.ceil(end / step) * step)
    }
  }

  // Where each clip ended up, read from its mark, which then goes.
  const found = new Map<number, VideoClipTarget>()
  for (const file of new Set([
    ...plans.map((plan) => plan.file),
    ...carried.map((one) => one.file),
  ])) {
    const text = work.text(file)
    const marked = timelineOf(work, file)
      .clips.filter((clip) => clip.source.attributes[PLACING])
      .sort((a, b) => b.source.element.start - a.source.element.start)
    for (const clip of marked) {
      const at = clip.source.attributes[PLACING]
      found.set(Number(at ? attributeValue(text, at) : Number.NaN), {
        file,
        clip: videoTarget(clip),
      })
      setAttributes(work, file, clip.source, { [PLACING]: null })
    }
  }

  return {
    clips: plans.flatMap((plan) => {
      const at = found.get(plan.index)
      return at ? [at] : []
    }),
    animationsLeft: left.flatMap(({ index, scene }) => {
      const clip = found.get(index)
      return clip ? [{ clip, scene }] : []
    }),
    animationsJoined: joined.flatMap(({ index, scene }) => {
      const clip = found.get(index)
      return clip ? [{ clip, scene }] : []
    }),
    looksMayDiffer: [...uncertain].flatMap((index) => {
      const clip = found.get(index)
      return clip ? [clip] : []
    }),
  }
}

/**
 * Where a clip of `own` placed at `startMs` for `durationMs` plays, part by part: from the scene
 * that holds its start, its own while that does, else the one on top there, the later in play
 * order, as the hosts stack in a crossfade; in a gap between scenes, from the next one's start;
 * past every scene, in the last. Past that scene's end, the rest goes on in the next scene, from
 * where the first ends, so nothing shows twice in a crossfade, and so on; the last holds whatever
 * is left. A clip that writes no length is never split. A part shorter than a clip may be, a few
 * frames past a scene's edge, is left out, unless it is all there is.
 */
function partsOf(
  scenes: readonly Scene[],
  own: Scene,
  startMs: number,
  durationMs: number | undefined
): Part[] {
  const end = (scene: Scene) => scene.startMs + scene.durationMs
  const holds = (scene: Scene, ms: number) => scene.startMs <= ms && ms < end(scene)
  const onTop = (ms: number, except?: Scene) =>
    scenes.filter((scene) => scene !== except && holds(scene, ms)).at(-1)
  const from = (ms: number, except?: Scene) =>
    scenes.find((scene) => scene !== except && scene.startMs >= ms)
  const last = scenes.reduce((latest, scene) => (end(scene) >= end(latest) ? scene : latest), own)
  const next = (scene: Scene) => sceneAfter(scenes, scene)

  let scene = (holds(own, startMs) ? own : undefined) ?? onTop(startMs) ?? from(startMs) ?? last
  const first = Math.max(startMs, scene.startMs)
  if (durationMs === undefined) return [{ scene, startMs: first, durationMs, intoMs: 0 }]

  const clipEnd = first + durationMs
  const pieces: Part[] = []
  let at = first
  for (;;) {
    const after = clipEnd > end(scene) + SAME_MS ? next(scene) : undefined
    const until = after ? end(scene) : clipEnd
    pieces.push({ scene, startMs: at, durationMs: until - at, intoMs: at - first })
    if (!after) break

    at = Math.max(end(scene), after.startMs)
    if (at >= clipEnd) break
    scene = after
  }

  const kept = pieces.filter((piece) => (piece.durationMs ?? 0) >= MIN_CLIP_MS)
  if (kept.length > 0) return kept
  const longest = pieces.reduce((a, b) => ((b.durationMs ?? 0) > (a.durationMs ?? 0) ? b : a))
  return [longest]
}

/**
 * A recording's parts cut again where it skips on in its file, so each plays one stretch of it:
 * two pieces back to back in a scene, which go on one from the other. A skip however close to a
 * part's edge cuts it there: what its words left out is never heard again. A piece shorter than a
 * frame, a skip that close to an edge, is left out, less than a frame of what they kept.
 */
function atJumps(parts: readonly Part[], placing: Placing, frameMs: number): Part[] {
  const jumps = placing.jumps ?? []
  if (jumps.length === 0) return [...parts]

  return parts.flatMap((part) => {
    if (part.durationMs === undefined) return [part]
    const end = part.intoMs + part.durationMs
    const cuts = jumps.map((jump) => jump.intoMs).filter((at) => at > part.intoMs && at < end)
    const edges = [part.intoMs, ...cuts, end]
    const pieces = edges.slice(1).map((to, at) => {
      const from = edges[at] as number
      return {
        ...part,
        startMs: part.startMs + from - part.intoMs,
        durationMs: to - from,
        intoMs: from,
      }
    })
    const whole = pieces.filter((piece) => piece.durationMs >= frameMs)
    return whole.length > 0 ? whole : pieces
  })
}

/** A clip's element written for another file, the look it takes along, and what it is. */
interface Carried {
  readonly file: string
  readonly scene: string
  readonly track: VideoTrack
  readonly html: string
  /** The clip it is a part of, by its place among those placed. */
  readonly index: number
  readonly element: LookElement
  /** Its look, the key it carries it by, and the scene it is from, when it lands elsewhere. */
  readonly look?: Look
  readonly key?: string
  readonly home?: string
}

/**
 * What holds a clip landing in a scene, as a selector reads it: the video's root, the scene's host
 * and its composition, of which the clip is a child.
 */
function sceneContext(work: Working, scene: Scene): LookContext {
  const index = work.text(VIDEO_ENTRY)
  const composition =
    work.textOf(scene.src) === undefined ? undefined : readTimeline(work, scene.src)
  return [
    startTagOf(index, rootOf(work).root),
    startTagOf(index, scene.host),
    ...(composition ? [startTagOf(work.text(scene.src), composition.composition)] : []),
  ]
}

/** What holds a clip where it is: its scene's, and the elements of its file around it. */
function clipContext(work: Working, scene: Scene, text: string, clip: VideoClip): LookContext {
  const timeline = readTimeline(work, scene.src)
  const content = timeline?.composition.content
  const wrappers = content ? wrappersOf(text, content.start, clip.source.element.start) : []
  return [...sceneContext(work, scene), ...wrappers]
}

/** An element as a selector reads it, from its start tag alone. */
function startTagOf(text: string, source: VideoElementSource): LookElement {
  const html = text.slice(source.tag.start, source.tag.end)
  const element = lookElement(html, undefined)
  const id = element.attributes.get("id")
  return id ? { ...element, id } : element
}

/** The elements open at `to`, from `from` in a file, outermost first: what holds what is there. */
function wrappersOf(text: string, from: number, to: number): LookElement[] {
  const open: { readonly tag: string; readonly html: string }[] = []
  const tags = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)\b[^>]*>/g
  tags.lastIndex = from
  for (let match = tags.exec(text); match && match.index < to; match = tags.exec(text)) {
    const [html, closing, name] = match
    if (!name) continue
    const tag = name.toLowerCase()
    if (closing) {
      const at = open.map((each) => each.tag).lastIndexOf(tag)
      if (at >= 0) open.length = at
      continue
    }
    if (VOID_TAGS.has(tag) || html.endsWith("/>")) continue
    // What a script or a style holds is no element.
    if (tag === "script" || tag === "style") {
      const end = text.indexOf(`</${tag}`, tags.lastIndex)
      tags.lastIndex = end < 0 ? text.length : end
      continue
    }
    open.push({ tag, html })
  }
  return open.map(({ html }) => {
    const element = lookElement(html, undefined)
    const id = element.attributes.get("id")
    return id ? { ...element, id } : element
  })
}

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
])

/** An element as a selector reads it, from its HTML, by the id it has where it is. */
function lookElement(html: string, id: string | undefined): LookElement {
  const source = readElement(html)
  const attributes = new Map<string, string>()
  for (const [name, at] of Object.entries(source.attributes)) {
    attributes.set(name, attributeValue(html, at) ?? "")
  }
  return {
    tag: (/^<([a-zA-Z][\w-]*)/.exec(html)?.[1] ?? "").toLowerCase(),
    ...(id ? { id } : {}),
    classes: (attributes.get("class") ?? "").split(/\s+/).filter(Boolean),
    attributes,
  }
}

/**
 * An element as the selectors of its file may read it, by its tag, id, classes and the attributes
 * they name: elements alike so have one look there, which a placement works out once for them all.
 */
function lookSignature(element: LookElement, read: ReadonlySet<string>): string {
  const attributes = [...element.attributes].filter(([name]) => read.has(name.toLowerCase()))
  return JSON.stringify([element.tag, element.id, element.classes, attributes])
}

/** The attributes some selector of these sheets names, `[name…]`, at any depth. */
function attributesRead(sheets: readonly (readonly CssBlock[])[]): Set<string> {
  const read = new Set<string>()
  for (const blocks of sheets) {
    for (const { prelude, body } of blocks) {
      for (const match of `${prelude}{${body}`.matchAll(/\[\s*([\w-]+)/g)) {
        read.add((match[1] ?? "").toLowerCase())
      }
    }
  }
  return read
}

/** A file's `<style>` elements: each one's CSS, and the look it is, by its key, if it is one. */
function stylesIn(
  text: string
): { readonly css: string; readonly look?: string; readonly from?: string }[] {
  return [...text.matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi)].map((match) => {
    const attributes = match[1] ?? ""
    const look = /\sdata-look\s*=\s*"([^"]*)"/.exec(attributes)?.[1]
    const from = /\sdata-from\s*=\s*"([^"]*)"/.exec(attributes)?.[1]
    return { css: match[2] ?? "", ...(look ? { look } : {}), ...(from ? { from } : {}) }
  })
}

/** The stylesheets `index.html` links, each as its blocks. */
function linkedBlocks(work: Working): CssBlock[][] {
  const exists = (path: string) => work.has(path)
  return rootOf(work).links.stylesheets.flatMap((link) => {
    const path = videoFilePath(VIDEO_ENTRY, link.value, exists)
    const css = path === undefined ? undefined : work.textOf(path)
    return css === undefined ? [] : [cssBlocks(css)]
  })
}

/**
 * The sheets that give a clip of a scene's file its look, in the order the page reads them, and the
 * scene it is from when it came with a look of its own, by `key`: then that look, and the rules
 * naming it by its id; else every rule that styles it there.
 */
function lookSheets(
  styles: readonly { readonly css: string; readonly look?: string; readonly from?: string }[],
  key: string | undefined,
  linked: readonly (readonly CssBlock[])[],
  parsed: (css: string) => readonly CssBlock[]
): { readonly sheets: LookSheet[]; readonly home?: string } {
  const own = key ? styles.find((style) => style.look === key) : undefined
  const byId = own !== undefined
  // In the order the page reads them: the linked sheets in its head, the scene's own styles,
  // then the look carried in, written after them.
  const sheets: LookSheet[] = [
    ...linked.map((blocks) => ({ blocks, byId, shared: true })),
    ...styles
      .filter((style) => style.look === undefined)
      .map((style) => ({ blocks: parsed(style.css), byId })),
    ...(own ? [{ blocks: parsed(own.css), carried: true }] : []),
  ]
  return { sheets, ...(own?.from ? { home: own.from } : {}) }
}

/** The keyframes a scene's file reads by name: its own, its linked sheets', and its looks'. */
function sceneKeyframes(
  work: Working,
  file: string,
  linked: readonly (readonly CssBlock[])[]
): SceneKeyframes {
  const own = new Map<string, string>()
  const carried = new Map<string, string[]>()
  const styles = stylesIn(work.text(file))
  for (const blocks of [
    ...styles.filter((style) => !style.look).map((style) => cssBlocks(style.css)),
    ...linked,
  ]) {
    for (const [name, body] of keyframesOf(blocks)) if (!own.has(name)) own.set(name, body)
  }
  for (const style of styles.filter((each) => each.look)) {
    for (const [name, body] of keyframesOf(cssBlocks(style.css))) {
      carried.set(name, [...(carried.get(name) ?? []), body])
    }
  }
  return { own, carried }
}

/** The keys of the looks a file writes, `<style data-look="<key>">`. */
function looksIn(text: string): string[] {
  return stylesIn(text).flatMap((style) => (style.look ? [style.look] : []))
}

/** The looks a file writes, `<style data-look="<key>">`, each by its key and where it is. */
function lookBlocks(
  text: string
): { readonly key: string; readonly start: number; readonly end: number }[] {
  return [...text.matchAll(/<style\b([^>]*)>[\s\S]*?<\/style>/gi)].flatMap((match) => {
    const key = /\sdata-look\s*=\s*"([^"]*)"/.exec(match[1] ?? "")?.[1]
    return key ? [{ key, start: match.index, end: match.index + match[0].length }] : []
  })
}

/**
 * Removes each look of a file no element of it carries any more, and a look written twice, as two
 * people carrying it in at once may leave it, but once.
 */
function pruneLooks(work: Working, file: string): void {
  if (!work.textOf(file)?.includes("data-look")) return
  for (const key of new Set(looksIn(work.text(file)))) {
    const name = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    for (;;) {
      const text = work.text(file)
      const blocks = lookBlocks(text).filter((block) => block.key === key)
      // Each style names its key once itself; each element carrying it, once more.
      const named = text.match(new RegExp(`\\sdata-look\\s*=\\s*"${name}"`, "g"))?.length ?? 0
      const extra = named > blocks.length ? blocks.slice(1) : blocks
      const last = extra.at(-1)
      if (!last) break
      work.replace(file, ...spanOf(lineBlock(text, last)), "")
    }
  }
}

/**
 * Writes each look carried into a file from the scene `home` in a style of its own, once for all
 * the clips that carry it, `<style data-look="<key>" data-from="<home>">`, a child of the
 * composition before the scripts that close it, which a later move finds and takes along. All at
 * once, the file read once.
 */
function writeLooks(
  work: Working,
  file: string,
  looks: readonly {
    readonly key: string
    readonly home: string
    readonly rules: readonly string[]
  }[]
): void {
  if (looks.length === 0) return

  const text = work.text(file)
  const timeline = timelineOf(work, file)
  const children = timeline.children
  let closing = children.length
  while (closing > 0 && children[closing - 1]?.tag === "script") closing -= 1
  const next = children[closing]
  const previous = children[closing - 1]
  const indent = next
    ? lineIndent(text, next.source.element.start)
    : previous
      ? lineIndent(text, previous.source.element.start)
      : `${lineIndent(text, timeline.composition.element.start)}  `

  const styles = looks
    .map(({ key, home, rules }) => {
      const body = rules.map((rule) => `${indent}  ${rule.replace(/\n/g, `\n${indent}  `)}`)
      return `<style data-look="${escapeAttribute(key)}" data-from="${escapeAttribute(home)}">\n${body.join("\n")}\n${indent}</style>`
    })
    .join(`\n${indent}`)

  if (next && aloneOnLine(text, next.source.element.start)) {
    const lineStart = text.lastIndexOf("\n", next.source.element.start - 1) + 1
    work.replace(file, lineStart, lineStart, `${indent}${styles}\n`)
  } else if (previous) {
    const block = lineBlock(text, previous.source.element)
    work.replace(file, block.end, block.end, `${indent}${styles}${lineEnd(text, block)}`)
  } else {
    const content = timeline.composition.content
    if (!content) throw new EditError(`${file}: its composition holds nothing a style can join.`)
    work.replace(file, content.start, content.start, `\n${indent}${styles}`)
  }
}

/** Whether only spaces come before `at` on its line. */
function aloneOnLine(text: string, at: number): boolean {
  return text.slice(text.lastIndexOf("\n", at - 1) + 1, at).trim() === ""
}

/** A file's inline scripts, as one text. */
function scriptsOf(text: string): string {
  return [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1] ?? "")
    .join("\n")
}

function spanOf(span: VideoSourceSpan): [number, number] {
  return [span.start, span.end]
}

/** A file's path as a scene's file writes it, rebased for another; undefined when unchanged. */
function rebased(work: Working, from: string, to: string, written: string): string | undefined {
  const exists = (path: string) => work.has(path)
  const path = videoFilePath(from, written, exists)
  if (path === undefined || videoFilePath(to, written, exists) === path) return undefined

  const up = "../".repeat(to.split("/").length - 1)
  return [path, `${up}${path}`].find((each) => videoFilePath(to, each, exists) === path)
}

/** The clip a placement marked with `index`. */
function markedClip(text: string, clips: readonly VideoClip[], index: number): VideoClip {
  const found = clips.find((clip) => {
    const at = clip.source.attributes[PLACING]
    return at !== undefined && attributeValue(text, at) === String(index)
  })
  if (!found) throw new EditError("A clip changed while it was placed: try again.")
  return found
}

/** An attribute a clip writes, as written. */
function attributeOf(text: string, clip: VideoClip, name: string): string | undefined {
  const at = clip.source.attributes[name]
  return at ? attributeValue(text, at) : undefined
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item])
  return groups
}

// Text, inside ------------------------------------------------------------------------------------

/**
 * Sets attributes of an element, read from `source`: a value written again in place, one it lacks
 * added at the end of its start tag, null removed. From the last to the first, so each span still
 * names what it named.
 */
function setAttributes(
  work: Working,
  file: string,
  source: VideoElementSource,
  values: Readonly<Record<string, string | null>>
): void {
  const text = work.text(file)
  const steps: { readonly at: number; readonly run: () => void }[] = []
  const added: string[] = []

  for (const [name, value] of Object.entries(values)) {
    // Two people writing one value at once leave it twice: the first counts, as in a browser,
    // and the next write keeps it alone.
    for (const copy of laterCopies(text, source, name)) {
      steps.push({ at: copy.start, run: () => work.replace(file, copy.start, copy.end, "") })
    }

    const at = source.attributes[name]
    if (!at) {
      if (value !== null) added.push(` ${name}="${escapeAttribute(value)}"`)
      continue
    }

    if (value === null) {
      // The attribute and the space before it.
      let start = at.start
      while (start > 0 && /[ \t\n\r]/.test(text[start - 1] ?? "")) start -= 1
      steps.push({ at: at.start, run: () => work.replace(file, start, at.end, "") })
      continue
    }

    const span = valueSpan(text, at)
    if (!span) {
      steps.push({
        at: at.start,
        run: () => work.replace(file, at.start, at.end, `${name}="${escapeAttribute(value)}"`),
      })
      continue
    }
    const written = span.quoted ? escapeAttribute(value) : `"${escapeAttribute(value)}"`
    if (attributeValue(text, at) === value) continue
    steps.push({ at: at.start, run: () => work.replace(file, span.start, span.end, written) })
  }

  if (added.length > 0) {
    const close = text.slice(source.tag.start, source.tag.end).endsWith("/>") ? 2 : 1
    let at = source.tag.end - close
    while (at > source.tag.start && /[ \t\n\r]/.test(text[at - 1] ?? "")) at -= 1
    steps.push({ at, run: () => work.replace(file, at, at, added.join("")) })
  }

  for (const step of steps.sort((a, b) => b.at - a.at)) step.run()
}

/** Each copy of an attribute its start tag writes after the first, with the space before it. */
function laterCopies(text: string, source: VideoElementSource, name: string): VideoSourceSpan[] {
  const first = source.attributes[name]
  if (!first) return []

  const copies: VideoSourceSpan[] = []
  const pattern = /\s+([^\s"'>/=]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/y
  let at = first.end
  for (;;) {
    pattern.lastIndex = at
    const match = pattern.exec(text)
    if (!match?.[1] || match.index + match[0].length > source.tag.end) break
    if (match[1].toLowerCase() === name) {
      copies.push({ start: match.index, end: match.index + match[0].length })
    }
    at = match.index + match[0].length
  }
  return copies
}

/** An element's HTML, written alone, with attributes set as {@link setAttributes} sets them. */
function withAttributes(html: string, values: Readonly<Record<string, string | null>>): string {
  const scratch = new Working(new Map([["element.html", html]]))
  const source = readElement(html)
  setAttributes(scratch, "element.html", source, values)
  return scratch.text("element.html")
}

/** The first element of a piece of HTML, where it writes its attributes. */
function readElement(html: string): VideoElementSource {
  const tag = /^<([a-zA-Z][\w-]*)/.exec(html)
  if (!tag) throw new EditError("An element was expected.")

  const attributes: Record<string, VideoSourceSpan> = {}
  const pattern = /\s+([^\s"'>/=]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/y
  let at = tag[0].length
  for (;;) {
    pattern.lastIndex = at
    const match = pattern.exec(html)
    if (!match?.[1]) break
    const name = match[1].toLowerCase()
    const start = match.index + match[0].length - match[0].trimStart().length
    attributes[name] ??= { start, end: match.index + match[0].length }
    at = match.index + match[0].length
  }

  const close = html.indexOf(">", at)
  if (close < 0) throw new EditError("An element's start tag was not closed.")
  return { element: { start: 0, end: html.length }, tag: { start: 0, end: close + 1 }, attributes }
}

/** Where an attribute's value is written, inside its quotes when it has them; none for a bare name. */
function valueSpan(
  text: string,
  at: VideoSourceSpan
): { readonly start: number; readonly end: number; readonly quoted: boolean } | undefined {
  const written = text.slice(at.start, at.end)
  const equals = written.indexOf("=")
  if (equals < 0) return undefined

  let start = at.start + equals + 1
  while (/[ \t\n\r]/.test(text[start] ?? "")) start += 1
  const quote = text[start]
  if (quote === '"' || quote === "'") return { start: start + 1, end: at.end - 1, quoted: true }
  return { start, end: at.end, quoted: false }
}

/** An attribute's value as written, its entities decoded. */
function attributeValue(text: string, at: VideoSourceSpan): string | undefined {
  const span = valueSpan(text, at)
  if (!span) return undefined
  return decodeEntities(text.slice(span.start, span.end))
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** Milliseconds written as seconds, to the millisecond: `4200` as `4.2`. */
function seconds(ms: number): string {
  return String(Math.round(ms) / 1000)
}

/** Ranges sorted, and those that touch or overlap joined. */
function mergeRanges(ranges: readonly VideoRange[]): VideoRange[] {
  const sorted = ranges
    .filter((range) => range.endMs > range.startMs)
    .sort((a, b) => a.startMs - b.startMs)
  const merged: VideoRange[] = []
  for (const range of sorted) {
    const last = merged.at(-1)
    if (last && range.startMs <= last.endMs) {
      merged[merged.length - 1] = {
        startMs: last.startMs,
        endMs: Math.max(last.endMs, range.endMs),
      }
    } else {
      merged.push(range)
    }
  }
  return merged
}

/**
 * An element with its line: from the line's start when only spaces come before it, through its
 * line's end when only spaces follow, so removing it leaves no blank line.
 */
function lineBlock(text: string, span: VideoSourceSpan): VideoSourceSpan {
  let start = span.start
  while (start > 0 && (text[start - 1] === " " || text[start - 1] === "\t")) start -= 1
  const alone = start === 0 || text[start - 1] === "\n"
  if (!alone) return span

  let end = span.end
  while (end < text.length && (text[end] === " " || text[end] === "\t")) end += 1
  if (text[end] === "\r") end += 1
  if (text[end] === "\n") return { start, end: end + 1 }
  return end === text.length ? { start, end } : span
}

/** What ends a line block: nothing when it took its line's end with it, else a line break. */
function lineEnd(text: string, block: VideoSourceSpan): string {
  return text[block.end - 1] === "\n" ? "\n" : ""
}

/** The spaces a line starts with, before `at`. */
function lineIndent(text: string, at: number): string {
  const line = text.lastIndexOf("\n", at - 1) + 1
  return /^[ \t]*/.exec(text.slice(line, at))?.[0] ?? ""
}
