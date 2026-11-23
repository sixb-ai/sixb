import { type DefaultTreeAdapterTypes, parse, parseFragment } from "parse5"
import type { VideoSourceSpan } from "./composition"

// What a composition plays, clip by clip, where its file writes each: the timed elements an editor
// trims, moves and splits, and the words it shows, which an editor types into. `index.html` plays
// its own clips over every scene, a soundtrack most often; a scene file plays its own, timed from
// the scene's start. Browser-safe, as `composition.ts`. See README.md.

type Node = DefaultTreeAdapterTypes.Node
type Element = DefaultTreeAdapterTypes.Element

/** What a clip shows or plays. */
export type VideoClipKind = "video" | "audio" | "image" | "text" | "element"

/** The rows an editor lays clips on: what is seen, what is read, and what is heard. */
export type VideoTrack = "picture" | "text" | "sound"

/** An element where its file writes it, for an editor to change it in place. */
export interface VideoElementSource {
  /** The whole element, its end tag included. */
  readonly element: VideoSourceSpan
  /** Its start tag. */
  readonly tag: VideoSourceSpan
  /** Each attribute it writes, by name, as the span of its name and value. */
  readonly attributes: Readonly<Record<string, VideoSourceSpan>>
  /** What it holds, between its start tag and its end tag; none for a void element. */
  readonly content?: VideoSourceSpan
}

/** A timed element of a composition: footage, a sound, a picture, a line of text. */
export interface VideoClip {
  /**
   * How an edit names it in its file: its `id`, else `#<n>`, its place among the file's clips.
   * An `id` survives edits around it; a place, only edits that add or remove no clip before it.
   */
  readonly ref: string
  readonly id?: string
  readonly tag: string
  readonly kind: VideoClipKind
  readonly track: VideoTrack
  /** A caption: a line of what is said, as the Agent's guide writes them. */
  readonly caption: boolean
  /** From its composition's start: a scene's, or the video's for `index.html`. */
  readonly startMs: number
  /** As its `data-duration` writes it; none when it plays until its file or its composition ends. */
  readonly durationMs?: number
  /** Where in its file it starts playing, from `data-media-start`. */
  readonly mediaStartMs: number
  /** The file it plays or shows, as written. */
  readonly src?: string
  /** From `data-volume`, 1 as recorded. */
  readonly volume?: number
  readonly fadeInMs?: number
  readonly fadeOutMs?: number
  /**
   * A clip whose sound is not played, as HyperFrames mixes it: footage `muted`, or with a
   * `data-has-audio` other than "true"; a sound `muted`.
   */
  readonly silent: boolean
  /** What a text clip says. */
  readonly text?: string
  /**
   * The clip it goes on from, by its id, from `data-continues`: a part of that clip in a later
   * scene, which an editor edits with it as one (see {@link videoChains}).
   */
  readonly continues?: string
  readonly source: VideoElementSource
}

/** An element whose words an editor may type over: it holds text alone. */
export interface VideoText {
  /** Its `id`, else `<tag>:<n>`, its place among the file's texts. */
  readonly ref: string
  readonly tag: string
  readonly text: string
  /** Its `class`, which says what it is to whoever reads the list: a title, a callout. */
  readonly className?: string
  /** Whether it is also a clip: timed by `data-start`. */
  readonly timed: boolean
  readonly source: VideoElementSource
}

/** One composition's clips and texts, in the order its file writes them. */
export interface VideoFileTimeline {
  readonly clips: readonly VideoClip[]
  readonly texts: readonly VideoText[]
  /** The composition's own element, which new clips go into. */
  readonly composition: VideoElementSource
  /** The elements it holds itself, in order, each by its tag: where a new clip may go. */
  readonly children: readonly { readonly tag: string; readonly source: VideoElementSource }[]
}

/** The tags whose words an editor may type over, when they hold text alone. */
const TEXT_TAGS: ReadonlySet<string> = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "span",
  "div",
  "li",
  "strong",
  "em",
  "small",
  "blockquote",
  "figcaption",
  "label",
  "a",
  "button",
])

/** Elements that only break a line inside words. */
const LINE_BREAKS: ReadonlySet<string> = new Set(["br", "wbr"])

/** Elements that only style words inside a line, such as a caption's highlighted word. */
const INLINE_STYLES: ReadonlySet<string> = new Set([
  "span",
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "mark",
  "small",
  "sub",
  "sup",
])

/**
 * The clips and texts of a scene file: the timed elements in its `<template>`'s composition,
 * leaving out what a composition it nests holds. Null for a file that is not one.
 */
export function readSceneTimeline(html: string): VideoFileTimeline | null {
  const fragment = parseFragment(html, { sourceCodeLocationInfo: true })
  const template = fragment.childNodes.find(
    (node): node is Element => "tagName" in node && node.tagName === "template"
  )
  if (!template) return null

  const composition = elements(contentOf(template)).find((element) =>
    has(element, "data-composition-id")
  )
  return composition ? timelineOf(composition) : null
}

/**
 * The clips and texts `index.html` plays on its own timeline, beside its scenes: its soundtrack,
 * a logo over every scene. Null for a file without a root composition.
 */
export function readRootTimeline(html: string): VideoFileTimeline | null {
  const document = parse(html, { sourceCodeLocationInfo: true })
  const compositions = elements(document.childNodes).filter((element) =>
    has(element, "data-composition-id")
  )
  const root =
    compositions.find((element) => attribute(element, "data-root") === "true") ?? compositions[0]
  return root ? timelineOf(root) : null
}

/**
 * What `index.html`'s root paints of its own over the scenes before it: each element it holds
 * after its first scene's host, but the hosts, its sounds, and what shows nothing. HyperFrames
 * positions the timed ones, so a scene's `z-index` covers them unless theirs is higher. Empty for a
 * file without a root composition or a scene.
 */
export function readRootLayers(html: string): VideoElementSource[] {
  const document = parse(html, { sourceCodeLocationInfo: true })
  const compositions = elements(document.childNodes).filter((element) =>
    has(element, "data-composition-id")
  )
  const root =
    compositions.find((element) => attribute(element, "data-root") === "true") ?? compositions[0]
  const children = root?.childNodes.filter((node): node is Element => "tagName" in node) ?? []

  const first = children.findIndex((element) => has(element, "data-composition-src"))
  if (first < 0) return []
  return children
    .slice(first + 1)
    .filter((element) => !has(element, "data-composition-src") && !UNSEEN_TAGS.has(element.tagName))
    .map(sourceOf)
}

/** What a composition holds that paints nothing. */
const UNSEEN_TAGS = new Set(["audio", "script", "style", "template", "link", "meta", "noscript"])

function timelineOf(composition: Element): VideoFileTimeline {
  // A nested composition, or a scene's host, and what it holds are its own.
  const own = elements(composition.childNodes, { stop: nests }).filter((element) => !nests(element))

  const timed = own.filter((element) => isClip(element))
  const ids = new Map<string, Element>()
  for (const element of timed) {
    const id = attribute(element, "id")
    if (id && !ids.has(id)) ids.set(id, element)
  }

  const clips: VideoClip[] = []
  const resolved = new Map<Element, VideoClip>()
  const startOf = (element: Element, seen: Set<Element>): number => {
    const known = resolved.get(element)
    if (known) return known.startMs
    const written = attribute(element, "data-start")?.trim() ?? ""
    return clipStart(written, (name) => {
      const other = ids.get(name)
      if (!other || seen.has(other)) return undefined
      seen.add(other)
      const start = startOf(other, seen)
      const duration = readMs(attribute(other, "data-duration"))
      return duration === undefined ? undefined : start + duration
    })
  }

  timed.forEach((element, index) => {
    const id = attribute(element, "id")?.trim() || undefined
    const kind = clipKind(element)
    const className = attribute(element, "class") ?? ""
    const durationMs = readMs(attribute(element, "data-duration"))
    const volume = readNumber(attribute(element, "data-volume"))
    const fadeInMs = readMs(attribute(element, "data-fade-in"))
    const fadeOutMs = readMs(attribute(element, "data-fade-out"))
    const src = attribute(element, "src")?.trim()
    const text = kind === "text" ? styledWordsOf(element) : undefined
    const continues = attribute(element, "data-continues")?.trim()

    const clip: VideoClip = {
      ref: id ?? `#${index}`,
      ...(id ? { id } : {}),
      tag: element.tagName,
      kind,
      track: kind === "audio" ? "sound" : kind === "text" ? "text" : "picture",
      caption: /\bcaptions?\b/.test(className),
      startMs: startOf(element, new Set([element])),
      ...(durationMs === undefined ? {} : { durationMs }),
      mediaStartMs: readMs(attribute(element, "data-media-start")) ?? 0,
      ...(src ? { src } : {}),
      ...(volume === undefined ? {} : { volume }),
      ...(fadeInMs === undefined ? {} : { fadeInMs }),
      ...(fadeOutMs === undefined ? {} : { fadeOutMs }),
      silent:
        (kind === "audio" && has(element, "muted")) ||
        (kind === "video" &&
          (has(element, "muted") || (has(element, "data-has-audio") && !hasAudio(element)))),
      ...(text === undefined ? {} : { text }),
      ...(continues ? { continues } : {}),
      source: sourceOf(element),
    }
    resolved.set(element, clip)
    clips.push(clip)
  })

  const counts = new Map<string, number>()
  const texts = own.flatMap((element): VideoText[] => {
    const text = TEXT_TAGS.has(element.tagName) ? wordsOf(element) : undefined
    if (text === undefined) return []

    const place = counts.get(element.tagName) ?? 0
    counts.set(element.tagName, place + 1)
    const id = attribute(element, "id")?.trim()
    const className = attribute(element, "class")?.trim()
    return [
      {
        ref: id || `${element.tagName}:${place}`,
        tag: element.tagName,
        text,
        ...(className ? { className } : {}),
        timed: has(element, "data-start"),
        source: sourceOf(element),
      },
    ]
  })

  const children = composition.childNodes
    .filter((node): node is Element => "tagName" in node)
    .map((element) => ({ tag: element.tagName, source: sourceOf(element) }))

  return { clips, texts, composition: sourceOf(composition), children }
}

/** Within this, two instants are one: under a frame at 60 fps. */
const SAME_MS = 15

/**
 * A frame at the slowest rate a video plays, 24 fps: a recording's pieces this close still go on
 * one from the other, as a placement leaves no piece shorter than a frame at a skip.
 */
const FRAME_MS = 42

/** A part of a clip laid in the video: its scene's file, the clip there, and when it plays. */
export interface VideoChainPart {
  readonly file: string
  readonly clip: VideoClip
  readonly startMs: number
  readonly endMs: number
}

/**
 * A clip and the parts that go on from it in the scenes after, past each one's end: one clip to
 * whoever edits it, from its first part's start to its last's end. Its parts are in play order,
 * the first, its head, holding the id each other names in `data-continues`. A recording cut by its
 * words goes on in pieces: two back to back in one scene, or across a scene's edge, each playing
 * its own stretch of the file.
 */
export interface VideoChain {
  readonly parts: readonly VideoChainPart[]
}

/**
 * The video's chains: each clip that parts in later scenes go on from, with those parts. A part
 * is one only while it goes on from the one before it, as the edit that cut it wrote it: the same
 * element, starting where that one ends, or where its own scene starts after a gap. One edited
 * apart, or whose head is gone, heads a chain of its own, or stands alone, so a video nobody cut
 * this way has none.
 */
export function videoChains(
  scenes: readonly VideoSceneSpan[],
  timelineOf: (file: string) => VideoFileTimeline | undefined
): VideoChain[] {
  const files = new Map<string, VideoSceneSpan>()
  for (const scene of scenes) if (!files.has(scene.src)) files.set(scene.src, scene)

  const parts: VideoChainPart[] = []
  const written = new Map<string, number>()
  for (const [file, scene] of files) {
    for (const clip of timelineOf(file)?.clips ?? []) {
      if (clip.id) written.set(clip.id, (written.get(clip.id) ?? 0) + 1)
      if (clip.durationMs === undefined) continue
      const startMs = scene.startMs + clip.startMs
      parts.push({ file, clip, startMs, endMs: startMs + clip.durationMs })
    }
  }
  // A head is the one clip of the video with its id: two that share it, as a copied scene's may,
  // head nothing.
  const byId = new Map(
    parts.flatMap((part) =>
      part.clip.id && written.get(part.clip.id) === 1 ? [[part.clip.id, part]] : []
    )
  )
  const sceneOf = (part: VideoChainPart) => files.get(part.file)

  const chains: VideoChain[] = []
  const following = new Map<string, VideoChainPart[]>()
  for (const part of parts) {
    if (!part.clip.continues) continue
    following.set(part.clip.continues, [...(following.get(part.clip.continues) ?? []), part])
  }

  for (const [id, after] of following) {
    // From its head, each link the part that goes on from the last one found, wherever it lies
    // among them, and of two that would, the one playing the file on from where it stops, else a
    // piece beside it in its scene: a part left stale by an edit hides none after it. A part left
    // over heads a chain of its own, as one whose head is gone.
    const left = after.sort((a, b) => a.startMs - b.startMs)
    const head = byId.get(id)
    let start: VideoChainPart | undefined = head ?? left.shift()
    while (start) {
      const chain = [start]
      for (;;) {
        const last = chain[chain.length - 1] as VideoChainPart
        const next = left.filter((part) => goesOn(scenes, last, part, sceneOf))
        const found =
          next.find((part) => playsOn(last, part)) ??
          next.find((part) => part.file === last.file) ??
          next[0]
        if (!found) break
        chain.push(...left.splice(left.indexOf(found), 1))
      }
      if (chain.length > 1) chains.push({ parts: chain })
      start = left.shift()
    }
  }
  return chains.sort((a, b) => (a.parts[0]?.startMs ?? 0) - (b.parts[0]?.startMs ?? 0))
}

/** A scene's file and where it plays in the video. */
export interface VideoSceneSpan {
  readonly src: string
  readonly startMs: number
  readonly durationMs: number
}

/**
 * The scene a clip that runs past `scene`'s end goes on in: the chapter on top at that instant,
 * the later in play order, else the next to start; none past the last. `scenes` in play order.
 * An overlay is never one (see {@link videoChapters}).
 */
export function sceneAfter<T extends { readonly startMs: number; readonly durationMs: number }>(
  scenes: readonly T[],
  scene: T
): T | undefined {
  const chapters = videoChapters(scenes)
  const end = scene.startMs + scene.durationMs
  const onTop = chapters
    .filter((each) => each !== scene && each.startMs <= end && end < each.startMs + each.durationMs)
    .at(-1)
  return onTop ?? chapters.find((each) => each !== scene && each.startMs >= end)
}

/**
 * The scenes that are the video's chapters, in play order: every one but an overlay, a scene laid
 * over the others, as captions written over the whole video: one that holds two others whole, or
 * the span of all the others, from the first's start to the last's end. One short chapter inside a
 * longer one's crossfade leaves both chapters; of two alike, the later is the overlay. An
 * overlay's clips stay its own: no clip goes into it or out.
 */
export function videoChapters<T extends { readonly startMs: number; readonly durationMs: number }>(
  scenes: readonly T[]
): T[] {
  const end = (scene: T) => scene.startMs + scene.durationMs
  const holds = (outer: T, inner: T) => outer.startMs <= inner.startMs && end(inner) <= end(outer)
  // Of two alike, the earlier is held by the later, never the other way round.
  const within = (outer: T, inner: T, outerAt: number, innerAt: number) =>
    holds(outer, inner) && (!holds(inner, outer) || innerAt < outerAt)

  return scenes.filter((scene, at) => {
    const others = scenes.filter((other) => other !== scene)
    if (others.length === 0) return true
    const held = others.filter((other) => within(scene, other, at, scenes.indexOf(other)))
    if (held.length >= 2) return false
    const first = Math.min(...others.map((other) => other.startMs))
    const last = Math.max(...others.map(end))
    const spans = scene.startMs <= first && last <= end(scene)
    return !(spans && held.length === others.length)
  })
}

/**
 * Whether `next` goes on from `previous` as a placement or a cut wrote it, whatever was done to
 * their scenes since: the same element, and
 * - a recording's piece in the same scene, starting where `previous` ends: a cut by its words
 *   left both;
 * - a recording in the scene placement goes on in after `previous`'s, starting no later than that
 *   one's end, or its own start after a gap: a scene made shorter under `previous` hides its end,
 *   one made longer leaves a gap after it, and both stay one clip, which its next placement makes
 *   whole again. Where it plays its file from is its own, a cut at the edge skipping what it took,
 *   but only after a part that reaches its scene's end: past a gap, it plays the file on;
 * - anything else in that scene, from where `previous` reaches its scene's end, at least, starting
 *   there or where its own scene starts after a gap.
 */
function goesOn(
  scenes: readonly VideoSceneSpan[],
  previous: VideoChainPart,
  next: VideoChainPart,
  sceneOf: (part: VideoChainPart) => VideoSceneSpan | undefined
): boolean {
  const [a, b] = [previous.clip, next.clip]
  if (a.tag !== b.tag || a.src !== b.src || a.text !== b.text) return false
  const recording = b.kind === "video" || b.kind === "audio"
  if (previous.file === next.file) {
    return recording && Math.abs(next.startMs - previous.endMs) <= FRAME_MS
  }

  const before = sceneOf(previous)
  const after = sceneOf(next)
  if (!before || !after || sceneAfter(scenes, before) !== after) return false
  const sceneEnd = before.startMs + before.durationMs
  const from = Math.max(Math.min(previous.endMs, sceneEnd), after.startMs)

  if (recording) {
    // Past a gap the scene made longer, only where it plays the file on: a part elsewhere in the
    // file goes on only from one that reaches its scene's end, so a stale one never links.
    const reaches = previous.endMs >= sceneEnd - FRAME_MS
    return (
      (reaches || playsOn(previous, next)) &&
      next.startMs <= Math.max(sceneEnd, after.startMs) + FRAME_MS
    )
  }
  if (previous.endMs < sceneEnd - SAME_MS) return false
  return Math.abs(next.startMs - from) <= SAME_MS
}

/**
 * Whether `next` would go on from `previous` as {@link videoChains} links parts, whatever head its
 * `data-continues` names: a part two edits at once left naming another.
 */
export function goesOnFrom(
  scenes: readonly VideoSceneSpan[],
  previous: VideoChainPart,
  next: VideoChainPart
): boolean {
  const sceneOf = (part: VideoChainPart) => scenes.find((scene) => scene.src === part.file)
  return goesOn(scenes, previous, next, sceneOf)
}

/** Whether `next` plays its file on from where `previous`, as written, stops. */
function playsOn(previous: VideoChainPart, next: VideoChainPart): boolean {
  const stops = previous.clip.mediaStartMs + (previous.clip.durationMs ?? 0)
  return Math.abs(next.clip.mediaStartMs - stops) <= SAME_MS
}

/** A composition nested in this one, whose clips are its own. */
function nests(element: Element): boolean {
  return has(element, "data-composition-id") || has(element, "data-composition-src")
}

/** A clip: an element with `data-start`, or a video or a sound, which plays from 0 without one. */
function isClip(element: Element): boolean {
  if (has(element, "data-composition-src")) return false
  return has(element, "data-start") || element.tagName === "video" || element.tagName === "audio"
}

function clipKind(element: Element): VideoClipKind {
  switch (element.tagName) {
    case "video":
      return "video"
    case "audio":
      return "audio"
    case "img":
    case "picture":
    case "svg":
      return "image"
    default:
      return styledWordsOf(element) === undefined ? "element" : "text"
  }
}

/**
 * A clip's start, in milliseconds: seconds, or the end of the clip it names, `n` seconds later or
 * sooner, as HyperFrames reads a scene's. One it cannot resolve starts at 0.
 */
function clipStart(written: string, endOf: (name: string) => number | undefined): number {
  if (written === "") return 0

  const seconds = Number(written)
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000))

  const offset = /^(.*?)\s*([+-])\s*((?:\d*\.)?\d+)$/.exec(written)
  const name = offset ? (offset[1] ?? "") : written
  const shift = offset ? (offset[2] === "-" ? -1 : 1) * Number(offset[3]) * 1000 : 0
  const end = endOf(name)
  return end === undefined ? 0 : Math.max(0, Math.round(end + shift))
}

function hasAudio(element: Element): boolean {
  return attribute(element, "data-has-audio")?.trim() === "true"
}

/**
 * The words an element reads as, its styled words included, such as a caption that colours one of
 * them; undefined for one that holds anything else, or nothing to read. It decides the text track;
 * only `wordsOf` decides what an editor may type over, since typing would drop the styling.
 */
function styledWordsOf(element: Element): string | undefined {
  const collect = (node: Element): string | undefined => {
    let words = ""
    for (const child of node.childNodes) {
      if ("tagName" in child) {
        if (LINE_BREAKS.has(child.tagName)) {
          words += " "
          continue
        }
        if (!INLINE_STYLES.has(child.tagName)) return undefined

        const inner = collect(child)
        if (inner === undefined) return undefined
        words += inner
      } else if (child.nodeName === "#text" && "value" in child) {
        words += child.value
      }
    }
    return words
  }

  const text = collect(element)?.replace(/\s+/g, " ").trim()
  return text === undefined || text === "" ? undefined : text
}

/**
 * The words an element holds when it holds text alone, line breaks aside, its spaces collapsed;
 * undefined for one that holds elements, or nothing to read.
 */
function wordsOf(element: Element): string | undefined {
  let words = ""
  for (const node of element.childNodes) {
    if ("tagName" in node) {
      if (!LINE_BREAKS.has(node.tagName)) return undefined
      words += " "
    } else if (node.nodeName === "#text" && "value" in node) {
      words += node.value
    }
  }

  const text = words.replace(/\s+/g, " ").trim()
  return text === "" ? undefined : text
}

function sourceOf(element: Element): VideoElementSource {
  const location = element.sourceCodeLocation
  const span = (at: { readonly startOffset: number; readonly endOffset: number } | undefined) => ({
    start: at?.startOffset ?? 0,
    end: at?.endOffset ?? 0,
  })

  const tag = span(location?.startTag)
  const end = location?.endTag
  return {
    element: span(location ?? undefined),
    tag,
    attributes: Object.fromEntries(
      Object.entries(location?.attrs ?? {}).map(([name, at]) => [name, span(at)])
    ),
    ...(end && end.startOffset >= tag.end
      ? { content: { start: tag.end, end: end.startOffset } }
      : {}),
  }
}

/** Seconds written in an attribute, as milliseconds; undefined unless a finite number of 0 or more. */
function readMs(written: string | undefined): number | undefined {
  const seconds = readNumber(written)
  return seconds === undefined || seconds < 0 ? undefined : Math.round(seconds * 1000)
}

function readNumber(written: string | undefined): number | undefined {
  const trimmed = written?.trim() ?? ""
  if (trimmed === "") return undefined
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : undefined
}

/**
 * The elements among the nodes and their descendants, in source order, a template's content
 * included. `stop` keeps an element but not what it holds.
 */
function elements(
  nodes: readonly Node[],
  options: { readonly stop?: (element: Element) => boolean } = {}
): Element[] {
  const found: Element[] = []
  const visit = (children: readonly Node[]) => {
    for (const node of children) {
      if (!("tagName" in node)) continue
      found.push(node)
      if (options.stop?.(node)) continue
      visit(node.childNodes)
      if (node.tagName === "template") visit(contentOf(node))
    }
  }
  visit(nodes)
  return found
}

function contentOf(element: Element): readonly Node[] {
  return "content" in element
    ? (element as DefaultTreeAdapterTypes.Template).content.childNodes
    : []
}

function attribute(element: Element, name: string): string | undefined {
  return element.attrs.find((each) => each.name === name)?.value
}

function has(element: Element, name: string): boolean {
  return element.attrs.some((each) => each.name === name)
}
