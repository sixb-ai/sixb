import { type DefaultTreeAdapterTypes, parse, parseFragment } from "parse5"
import { HTML_FILE_ATTRIBUTES } from "../html"
import { ARTIFACT_LIMITS } from "../limits"

// A video artifact is a HyperFrames project: `index.html`, the root composition, hosts one
// `<template>` scene file per scene, and the scenes play the files beside them. This reads the
// project the way HyperFrames resolves it, into the scenes and their times. Publishing checks a
// version with it, and editors read it in the browser. Browser-safe. See README.md.

type Node = DefaultTreeAdapterTypes.Node
type Element = DefaultTreeAdapterTypes.Element

/** The file a video plays from: its root composition, which hosts the scenes. */
export const VIDEO_ENTRY = "index.html"

/** The frame rates a video plays at; a root composition without `data-fps` plays at 30. */
export const VIDEO_FRAME_RATES = [24, 25, 30, 50, 60] as const

const DEFAULT_FPS = 30

/**
 * Where a scene starts, as its host's `data-start` writes it: at a number of seconds, or when
 * another scene ends, `offset` seconds later (`demo + 0.5`) or earlier (`demo - 1`). `scene` is
 * the name as written: the other scene's id, or its host's own `id`.
 */
export type VideoStart =
  | { readonly type: "at"; readonly seconds: number }
  | { readonly type: "after"; readonly scene: string; readonly offset: number }

/** Where something is written in its file: its first character, and the one past its last. */
export interface VideoSourceSpan {
  readonly start: number
  readonly end: number
}

/** A file a composition plays or shows: `<video src>`, `<audio src>`, `<img src>`, and others. */
export interface VideoMediaReference {
  readonly element: string
  readonly attribute: string
  /** As written, its entities decoded: a path, an `artifact:` address, or a URL. */
  readonly value: string
  /** The attribute, name and value, where its file writes it. */
  readonly at: VideoSourceSpan
}

/**
 * An element of `index.html`, a scene's host or the root, where an editor changes its attributes in
 * place.
 */
export interface VideoSceneHost {
  /** The whole element, its end tag included. */
  readonly element: VideoSourceSpan
  /** Its start tag. */
  readonly tag: VideoSourceSpan
  /** Each attribute it writes, by name, as the span of its name and value. */
  readonly attributes: Readonly<Record<string, VideoSourceSpan>>
}

export interface VideoScene {
  /**
   * Its host's `data-composition-id`, which its file's composition, `#<id>` addresses, comments and
   * the outline name it by.
   */
  readonly id: string
  /** Its host's own `id`, when it writes another: `data-start` may name the scene by either. */
  readonly hostId?: string
  /** Its host's `data-label`, HyperFrames' name for a scene. */
  readonly label?: string
  /** Its file in the version, from its host's `data-composition-src`. */
  readonly src: string
  readonly start: VideoStart
  readonly startMs: number
  readonly durationMs: number
  /** What its file plays and shows. */
  readonly media: readonly VideoMediaReference[]
  /** The compositions its file nests, each by its `data-composition-src`. */
  readonly compositions: readonly VideoMediaReference[]
  readonly host: VideoSceneHost
}

/** A video's composition: its frame, its length, and its scenes, resolved to times. */
export interface VideoComposition {
  readonly width: number
  readonly height: number
  readonly fps: number
  readonly durationMs: number
  /**
   * The instant that shows the video before it plays, from the root's `data-poster`, in
   * milliseconds within its length; none when the root writes none.
   */
  readonly posterMs?: number
  /** In the order they start; scenes that start together, in the order `index.html` lists them. */
  readonly scenes: readonly VideoScene[]
  /** What `index.html` plays and shows itself, under or over every scene: a soundtrack, a logo. */
  readonly media: readonly VideoMediaReference[]
  /** The root composition's element. */
  readonly root: VideoSceneHost
  /**
   * Each `<audio>` `index.html` plays beside its scenes, as the span of its whole element: heard,
   * never seen, since a page shows no `<audio>` without `controls`.
   */
  readonly sounds: readonly VideoSourceSpan[]
  /**
   * Whether `index.html` plays or animates anything beside its scenes, as its own text says: a
   * timed element, a video or a sound, an inline script, which may build a timeline, or a CSS
   * animation or transition. What a scene shows then depends on when it plays. A script loaded by
   * its `src` only loads a library; it and the stylesheets the root links are in `links`, for
   * whoever reads the version's files.
   */
  readonly rootTimeline: boolean
  /** The scripts and stylesheets `index.html` loads beside its scenes, by `src` and `href`. */
  readonly links: {
    readonly scripts: readonly VideoMediaReference[]
    readonly stylesheets: readonly VideoMediaReference[]
  }
}

/**
 * What `index.html` says on its own: the whole timeline, since each host writes its scene's start
 * and length, but not what the scene files play.
 */
export interface VideoRoot extends Omit<VideoComposition, "scenes"> {
  readonly scenes: readonly Omit<VideoScene, "media" | "compositions">[]
}

/** A scene file, read on its own, or a composition a scene nests. */
export interface VideoSceneFile {
  /** The `data-composition-id` of the composition its `<template>` holds. */
  readonly id: string
  readonly media: readonly VideoMediaReference[]
  /**
   * The compositions it nests, each an element with `data-composition-src` in its composition,
   * whose file loads from the project's root, as `index.html`'s scenes do.
   */
  readonly compositions: readonly VideoMediaReference[]
}

type Read<T> = T | { readonly error: string }

/**
 * Reads a whole project: `index.html`, then each scene file its hosts name, which `sceneFile`
 * hands over as text, or undefined when the version has no such file.
 */
export function readVideoComposition(
  index: string,
  sceneFile: (path: string) => string | undefined
): Read<{ readonly composition: VideoComposition }> {
  const root = parseVideoRoot(index)
  if ("error" in root) return root

  const files = new Map<string, VideoSceneFile>()
  for (const { id, src } of root.root.scenes) {
    const html = sceneFile(src)
    if (html === undefined) return { error: missingScene(id, src) }

    const scene = parseVideoScene(html, src)
    if ("error" in scene) return scene
    files.set(src, scene.scene)
  }

  return composeVideo(root.root, files)
}

/** Why a host's scene file is missing, for whoever reads the version's files themselves. */
export function missingScene(id: string, src: string): string {
  return `${VIDEO_ENTRY}: scene '${id}' plays '${src}', which is not one of the video's files.`
}

/**
 * Reads `index.html`: the root composition, the first element with `data-composition-id`, or the
 * one marked `data-root="true"`, as HyperFrames picks it, and the scene hosts in it, each an
 * element with `data-composition-src`, with every start resolved to a time.
 */
export function parseVideoRoot(html: string): Read<{ readonly root: VideoRoot }> {
  try {
    return { root: readRoot(html) }
  } catch (error) {
    if (error instanceof CompositionError) return { error: `${VIDEO_ENTRY}: ${error.message}` }
    throw error
  }
}

/**
 * Reads a scene file: a `<template>` holding one composition, whose `data-composition-id` its
 * host names. `file` is its path, which its errors name.
 */
export function parseVideoScene(
  html: string,
  file: string
): Read<{ readonly scene: VideoSceneFile }> {
  try {
    return { scene: readScene(html) }
  } catch (error) {
    if (error instanceof CompositionError) return { error: `${file}: ${error.message}` }
    throw error
  }
}

/** Puts a root and its scene files, by path, together: each file holds its host's composition. */
export function composeVideo(
  root: VideoRoot,
  files: ReadonlyMap<string, VideoSceneFile>
): Read<{ readonly composition: VideoComposition }> {
  const scenes: VideoScene[] = []
  for (const scene of root.scenes) {
    const file = files.get(scene.src)
    if (!file) return { error: missingScene(scene.id, scene.src) }
    if (file.id !== scene.id) {
      return {
        error: `${scene.src} holds composition '${file.id}', but its host in ${VIDEO_ENTRY} is '${scene.id}': give both one id.`,
      }
    }
    scenes.push({ ...scene, media: file.media, compositions: file.compositions })
  }

  return { composition: { ...root, scenes } }
}

/**
 * The version's file a reference in `file` names, as HyperFrames finds it: a path that climbs out
 * with `../`, or one beside `file` that the version holds, is read from `file`'s folder; any other
 * from the project's root, where scenes are played from. Its `?query` and `#fragment` are not part
 * of the path. Undefined for a reference that names no file of the version: an `artifact:`
 * address, a URL, a path from a site's root, or one that climbs out of the project.
 */
export function videoFilePath(
  file: string,
  value: string,
  exists: (path: string) => boolean
): string | undefined {
  const written = value.trim()
  if (written === "" || written.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(written)) {
    return undefined
  }

  const path = decodePath(written.replace(/[?#].*$/, ""))
  const folder = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ""
  if (folder === "") return normalizePath(path)

  const sibling = normalizePath(`${folder}/${path}`)
  if (path.startsWith("../") || (sibling !== undefined && exists(sibling))) return sibling
  return normalizePath(path)
}

class CompositionError extends Error {}

/**
 * A scene's id: a letter, then letters, digits, `-` and `_`. HyperFrames reads a `data-start` that
 * is a number as seconds, so an id never reads as one.
 */
const SCENE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

/** What HyperFrames reads as a scene's name in `data-start`, alone or before `+ n` or `- n`. */
const START_REFERENCE = /^[A-Za-z0-9_.:-]+$/
const START_OFFSET = /^(.*?)\s*([+-])\s*((?:\d*\.)?\d+)$/

const SCENE_EXAMPLE =
  '<div data-composition-id="intro" data-composition-src="scenes/intro.html" data-start="0" data-duration="4"></div>'

function readRoot(html: string): VideoRoot {
  const document = parse(html, { sourceCodeLocationInfo: true })
  const live = elements(document.childNodes)
  const compositions = live.filter((element) => has(element, "data-composition-id"))
  const root =
    compositions.find((element) => attribute(element, "data-root") === "true") ?? compositions[0]
  if (!root) {
    throw new CompositionError(
      'it has no root composition: wrap the video in <div data-composition-id="main" data-width="1920" data-height="1080">, its scenes inside.'
    )
  }

  const width = readSize(root, "data-width")
  const height = readSize(root, "data-height")
  const fps = readFps(root)

  const hosts = elements(root.childNodes).filter((element) => has(element, "data-composition-src"))
  if (hosts.length === 0) {
    throw new CompositionError(
      `its root composition hosts no scene: put each scene in it as ${SCENE_EXAMPLE}, its file a <template>.`
    )
  }
  if (hosts.length > ARTIFACT_LIMITS.maxVideoScenes) {
    throw new CompositionError(
      `a video holds at most ${ARTIFACT_LIMITS.maxVideoScenes} scenes; this one has ${hosts.length}.`
    )
  }

  const read = hosts.map((host) => readHost(host, root))
  checkNames(read, live, hosts)

  const starts = resolveStarts(read)
  // Sorting keeps the order of scenes that start together: the order index.html lists them.
  const scenes = read
    .map((scene) => ({ ...scene, startMs: starts.get(scene.id) ?? 0 }))
    .sort((a, b) => a.startMs - b.startMs)

  const durationMs = videoLength(root, hosts, fps, scenes)
  const posterMs = readPoster(root, durationMs)

  return {
    width,
    height,
    fps,
    durationMs,
    ...(posterMs === undefined ? {} : { posterMs }),
    scenes,
    media: mediaOf(document.childNodes),
    root: hostSource(root),
    sounds: rootSounds(document.childNodes, hosts),
    rootTimeline: playsOnItsOwn(document.childNodes, root, hosts),
    links: rootLinks(document.childNodes, hosts),
  }
}

/**
 * How long the video plays: until its last scene ends, or for the root's own `data-duration`,
 * which may run past it, under a closing soundtrack or a logo the root shows.
 */
function videoLength(
  root: Element,
  hosts: readonly Element[],
  fps: number,
  scenes: readonly { readonly id: string; readonly startMs: number; readonly durationMs: number }[]
): number {
  const end = Math.max(...scenes.map((scene) => scene.startMs + scene.durationMs))

  // Without a length of its own, HyperFrames plays the root until the last thing on its timeline
  // ends, a soundtrack as much as a scene, and a sound without data-duration for as long as its
  // file lasts: a length the HTML does not say. The root says it instead.
  const timed = has(root, "data-duration") ? undefined : ownTimeline(root, hosts)
  if (timed) {
    const id = attribute(timed, "id")
    throw new CompositionError(
      `<${timed.tagName}${id ? ` id="${id}"` : ""}> plays on the root composition's own timeline, so HyperFrames would play the video until it ends: give the root composition data-duration, the video's length in seconds.`
    )
  }

  const durationMs = has(root, "data-duration")
    ? readSeconds(root, "data-duration", "the root composition")
    : end

  // A rounded start or length can leave the last scene ending a little past the video. Less than
  // a frame past, the video cuts nothing anyone sees; a frame or more past, it cuts a frame.
  if ((end - durationMs) * fps >= 1000) {
    const last = scenes.find((scene) => scene.startMs + scene.durationMs === end)
    throw new CompositionError(
      `scene '${last?.id}' ends at ${end / 1000} s, after the root composition's data-duration of ${durationMs / 1000} s: lengthen the video, or end the scene sooner.`
    )
  }
  if (durationMs > ARTIFACT_LIMITS.maxVideoSeconds * 1000) {
    throw new CompositionError(
      `the video lasts ${durationMs / 1000} s; a video lasts at most ${ARTIFACT_LIMITS.maxVideoSeconds} s.`
    )
  }
  return durationMs
}

/**
 * The first element on the root's own timeline, beside its scenes: one with `data-start`, or a
 * video or sound, which HyperFrames plays from 0 without one. What a host holds is its scene's.
 */
function ownTimeline(root: Element, hosts: readonly Element[]): Element | undefined {
  const hosted = hostedBy(hosts)
  return elements(root.childNodes).find((element) => !hosted.has(element) && isTimed(element))
}

/** Whether CSS moves on its own as time passes: an animation or a transition. */
export function cssMoves(css: string): boolean {
  return /@keyframes|\banimation\b|\btransition\b/i.test(css)
}

/**
 * Whether `index.html` plays or animates anything beside its scenes, anywhere in it: what
 * `VideoComposition.rootTimeline` says.
 */
function playsOnItsOwn(nodes: readonly Node[], root: Element, hosts: readonly Element[]): boolean {
  const hosted = hostedBy(hosts)
  return elements(nodes).some((element) => {
    if (hosted.has(element) || element === root) return false

    const inline = element.tagName === "script" && !has(element, "src")
    return (
      isTimed(element) ||
      (inline && textOf(element).trim() !== "") ||
      (element.tagName === "style" && cssMoves(textOf(element))) ||
      cssMoves(attribute(element, "style") ?? "")
    )
  })
}

/** The `<audio>` elements `index.html` plays beside its scenes, which show nothing. */
function rootSounds(nodes: readonly Node[], hosts: readonly Element[]): VideoSourceSpan[] {
  const hosted = hostedBy(hosts)
  return elements(nodes).flatMap((element) => {
    const at = element.sourceCodeLocation
    if (element.tagName !== "audio" || hosted.has(element) || has(element, "controls") || !at) {
      return []
    }
    return [{ start: at.startOffset, end: at.endOffset }]
  })
}

/** The scripts and stylesheets `index.html` loads beside its scenes. */
function rootLinks(nodes: readonly Node[], hosts: readonly Element[]): VideoComposition["links"] {
  const hosted = hostedBy(hosts)
  const linked = (tag: string, name: string, matches: (element: Element) => boolean) =>
    elements(nodes).flatMap((element) => {
      const value = attribute(element, name)
      const at = element.sourceCodeLocation?.attrs?.[name]
      if (element.tagName !== tag || hosted.has(element) || !matches(element) || !value || !at) {
        return []
      }
      return [
        { element: tag, attribute: name, value, at: { start: at.startOffset, end: at.endOffset } },
      ]
    })

  return {
    scripts: linked("script", "src", () => true),
    stylesheets: linked("link", "href", (element) =>
      /\bstylesheet\b/i.test(attribute(element, "rel") ?? "")
    ),
  }
}

/** An element on a timeline: one with `data-start`, or a video or a sound. */
function isTimed(element: Element): boolean {
  return has(element, "data-start") || element.tagName === "audio" || element.tagName === "video"
}

/** The hosts and what they hold: their scenes', not the root's. */
function hostedBy(hosts: readonly Element[]): ReadonlySet<Element> {
  return new Set(hosts.flatMap((host) => [host, ...elements(host.childNodes)]))
}

/** A scene as its host in `index.html` writes it, before its start is resolved. */
interface HostedScene {
  readonly id: string
  readonly hostId?: string
  readonly label?: string
  readonly src: string
  readonly start: VideoStart
  readonly durationMs: number
  readonly host: VideoSceneHost
}

/** A scene host, refused unless it sits in the root composition itself. */
function readHost(host: Element, root: Element): HostedScene {
  const id = attribute(host, "data-composition-id")
  const named = id
    ? `scene '${id}'`
    : `the scene playing '${attribute(host, "data-composition-src")}'`

  const parent = closestComposition(host)
  if (parent !== root) {
    throw new CompositionError(
      `${named} sits inside composition '${parent ? attribute(parent, "data-composition-id") : ""}': put every scene host in the root composition itself.`
    )
  }
  if (id === undefined || !SCENE_ID.test(id)) {
    throw new CompositionError(
      `${named} needs a data-composition-id that starts with a letter, then letters, digits, - or _, such as "intro": it names the scene.`
    )
  }

  const hostId = attribute(host, "id")?.trim()

  const src = normalizePath(decodePath(attribute(host, "data-composition-src") ?? ""))
  if (src === undefined) {
    throw new CompositionError(
      `scene '${id}': data-composition-src names its file inside the project, such as "scenes/${id}.html".`
    )
  }

  const label = attribute(host, "data-label")?.replace(/\s+/g, " ").trim()
  return {
    id,
    ...(hostId && hostId !== id ? { hostId } : {}),
    ...(label ? { label: label.slice(0, ARTIFACT_LIMITS.maxTitleLength) } : {}),
    src,
    start: readStart(host, id),
    // HyperFrames' own timeline reads a scene's length from its host alone: a scene file's
    // data-duration leaves a host without one 0 seconds long there.
    durationMs: readSeconds(host, "data-duration", `scene '${id}'`),
    host: hostSource(host),
  }
}

/**
 * Refuses a name `data-start` could read two ways. HyperFrames finds what it names by element `id`
 * first, then by `data-composition-id`: so no two scenes share an id or a host's `id`, no host's
 * `id` is another scene's id, and no other element takes either name.
 */
function checkNames(
  hosts: readonly HostedScene[],
  all: readonly Element[],
  hostElements: readonly Element[]
): void {
  const ids = new Set<string>()
  for (const { id } of hosts) {
    if (ids.has(id)) throw new CompositionError(`two scenes are '${id}': give each its own id.`)
    ids.add(id)
  }

  const hostIds = new Set<string>()
  for (const { id, hostId } of hosts) {
    if (hostId === undefined) continue
    if (hostIds.has(hostId)) {
      throw new CompositionError(`two scene hosts have id "${hostId}": give each its own, or none.`)
    }
    if (ids.has(hostId)) {
      throw new CompositionError(
        `scene '${id}''s host has id "${hostId}", which is scene '${hostId}''s id, so data-start="${hostId}" would find '${id}': give the host another id, or none.`
      )
    }
    hostIds.add(hostId)
  }

  const other = all.find((element) => {
    const own = attribute(element, "id")
    return (
      own !== undefined && (ids.has(own) || hostIds.has(own)) && !hostElements.includes(element)
    )
  })
  if (other) {
    const name = attribute(other, "id")
    throw new CompositionError(
      `<${other.tagName} id="${name}"> takes the name of a scene, which data-start would find instead of the scene: rename the element.`
    )
  }
}

function readScene(html: string): VideoSceneFile {
  const fragment = parseFragment(html, { sourceCodeLocationInfo: true })
  const [template, ...rest] = elements(fragment.childNodes, { deep: false })
  const example = `<template><div data-composition-id="intro" data-width="1920" data-height="1080">…</div></template>`

  if (!template || template.tagName !== "template" || rest.length > 0) {
    throw new CompositionError(
      `a scene file is one <template> holding its composition, as ${example}.`
    )
  }

  const [composition] = elements(contentOf(template)).filter((element) =>
    has(element, "data-composition-id")
  )
  const id = composition && attribute(composition, "data-composition-id")
  if (!composition || !id) {
    throw new CompositionError(`its <template> holds no composition: write it as ${example}.`)
  }

  return {
    id,
    media: mediaOf(fragment.childNodes),
    compositions: elements(composition.childNodes).flatMap((element) => {
      const value = attribute(element, "data-composition-src")
      const at = element.sourceCodeLocation?.attrs?.["data-composition-src"]
      if (value === undefined || !at) return []
      return [
        {
          element: element.tagName,
          attribute: "data-composition-src",
          value,
          at: { start: at.startOffset, end: at.endOffset },
        },
      ]
    }),
  }
}

/**
 * Each scene's start, in milliseconds. A scene that starts after another starts when that one
 * ends, so a chain is resolved from its first scene; one that leads back to itself never starts.
 */
function resolveStarts(hosts: readonly HostedScene[]): ReadonlyMap<string, number> {
  // A host's own id first, as HyperFrames looks a name up; checkNames keeps the two apart.
  const byName = new Map([
    ...hosts.map((host) => [host.id, host] as const),
    ...hosts.flatMap((host) => (host.hostId ? [[host.hostId, host] as const] : [])),
  ])
  const starts = new Map<string, number>()
  const resolving: string[] = []

  const startOf = (host: HostedScene): number => {
    const known = starts.get(host.id)
    if (known !== undefined) return known

    if (resolving.includes(host.id)) {
      const cycle = resolving.slice(resolving.indexOf(host.id)).map((id) => `'${id}'`)
      if (cycle.length === 1) {
        throw new CompositionError(
          `scene '${host.id}' starts after itself, so it never starts: start it at a number of seconds, or after another scene.`
        )
      }
      throw new CompositionError(
        `scenes ${cycle.join(", ")} each start after another of them, so none starts: start one of them at a number of seconds.`
      )
    }

    const { start } = host
    let startMs: number
    if (start.type === "at") {
      startMs = Math.round(start.seconds * 1000)
    } else {
      const after = byName.get(start.scene)
      if (!after) {
        const others = hosts.filter((other) => other.id !== host.id).map((other) => `'${other.id}'`)
        throw new CompositionError(
          `scene '${host.id}' starts after '${start.scene}', which is no scene${others.length > 0 ? `; its scenes are ${others.slice(0, 8).join(", ")}${others.length > 8 ? ", …" : ""}` : ""}.`
        )
      }

      resolving.push(host.id)
      startMs = startOf(after) + after.durationMs + Math.round(start.offset * 1000)
      resolving.pop()
    }

    if (startMs < 0) {
      throw new CompositionError(
        `scene '${host.id}' starts at ${startMs / 1000} s: a scene starts at 0 or later.`
      )
    }
    starts.set(host.id, startMs)
    return startMs
  }

  for (const host of hosts) startOf(host)
  return starts
}

/** A host's `data-start`, read as HyperFrames reads it. */
function readStart(host: Element, id: string): VideoStart {
  const written = attribute(host, "data-start")?.trim() ?? ""
  const refuse = () =>
    new CompositionError(
      `scene '${id}' needs data-start: a number of seconds, "intro" to start when scene 'intro' ends, or "intro + 0.5" or "intro - 0.5" to start that much later or sooner.`
    )
  if (written === "") throw refuse()

  const seconds = Number(written)
  if (Number.isFinite(seconds)) return { type: "at", seconds }
  if (START_REFERENCE.test(written)) return { type: "after", scene: written, offset: 0 }

  const offset = START_OFFSET.exec(written)
  const [, scene = "", sign, magnitude = ""] = offset ?? []
  if (!offset || !START_REFERENCE.test(scene)) throw refuse()
  return { type: "after", scene, offset: (sign === "-" ? -1 : 1) * Number(magnitude) }
}

/**
 * A root composition's width or height: an even number of pixels, as H.264 encodes. HyperFrames
 * reads it with `parseInt`, so only digits read the same in both: it reads `1e3` as 1.
 */
function readSize(root: Element, name: "data-width" | "data-height"): number {
  const written = attribute(root, name)?.trim() ?? ""
  const value = /^\d+$/.test(written) ? Number(written) : Number.NaN
  const max = ARTIFACT_LIMITS.maxVideoSize
  if (!Number.isInteger(value) || value <= 0 || value > max || value % 2 !== 0) {
    throw new CompositionError(
      `the root composition's data-width and data-height are its frame's size in pixels, even numbers up to ${max}, such as 1920 and 1080.`
    )
  }
  return value
}

/** A root composition's frame rate: whole digits, as HyperFrames reads it, which refuses `30.0`. */
function readFps(root: Element): number {
  const written = attribute(root, "data-fps")?.trim()
  if (written === undefined || written === "") return DEFAULT_FPS

  const fps = /^\d+$/.test(written) ? Number(written) : Number.NaN
  if (!(VIDEO_FRAME_RATES as readonly number[]).includes(fps)) {
    throw new CompositionError(
      `data-fps is ${VIDEO_FRAME_RATES.join(", ")} frames a second, or ${DEFAULT_FPS} without one; it is "${written}".`
    )
  }
  return fps
}

/**
 * The root's `data-poster`, the instant in seconds that shows the video before it plays, as
 * milliseconds: from its start up to its last moment. HyperFrames reads no such attribute.
 */
function readPoster(root: Element, durationMs: number): number | undefined {
  const written = attribute(root, "data-poster")?.trim()
  if (written === undefined || written === "") return undefined

  const ms = Math.round(Number(written) * 1000)
  if (!Number.isFinite(ms) || ms < 0 || ms >= durationMs) {
    throw new CompositionError(
      `the root composition's data-poster is the instant that shows the video before it plays, in seconds from 0 up to its length of ${durationMs / 1000} s, such as 2.5; it is "${written}".`
    )
  }
  return ms
}

/** A length in seconds, a millisecond or more, as milliseconds. */
function readSeconds(element: Element, name: string, what: string): number {
  const written = attribute(element, name)?.trim() ?? ""
  const ms = Math.round(Number(written || Number.NaN) * 1000)
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new CompositionError(
      `${what}'s ${name} is its length in seconds, such as 4 or 2.5; it is "${written}".`
    )
  }
  return ms
}

/** Every file reference among the nodes, inside templates too, in source order. */
function mediaOf(nodes: readonly Node[]): VideoMediaReference[] {
  return elements(nodes, { templates: true }).flatMap((element) =>
    HTML_FILE_ATTRIBUTES.flatMap(({ element: tag, attribute: name }) => {
      if (element.tagName !== tag) return []
      const value = attribute(element, name)
      const at = element.sourceCodeLocation?.attrs?.[name]
      if (value === undefined || !at) return []
      return [
        {
          element: tag,
          attribute: name,
          value,
          at: { start: at.startOffset, end: at.endOffset },
        },
      ]
    })
  )
}

function hostSource(host: Element): VideoSceneHost {
  const location = host.sourceCodeLocation
  const span = (at: { readonly startOffset: number; readonly endOffset: number } | undefined) => ({
    start: at?.startOffset ?? 0,
    end: at?.endOffset ?? 0,
  })
  return {
    element: span(location ?? undefined),
    tag: span(location?.startTag),
    attributes: Object.fromEntries(
      Object.entries(location?.attrs ?? {}).map(([name, at]) => [name, span(at)])
    ),
  }
}

/**
 * The elements among the nodes and their descendants, in source order. A template's content is not
 * in the page until a script puts it there, as HyperFrames does with a scene's: it is left out
 * unless `templates` says. `deep: false` keeps the nodes' own elements alone.
 */
function elements(
  nodes: readonly Node[],
  options: { readonly templates?: boolean; readonly deep?: boolean } = {}
): Element[] {
  const { templates = false, deep = true } = options
  const found: Element[] = []
  const visit = (children: readonly Node[]) => {
    for (const node of children) {
      if (!("tagName" in node)) continue
      found.push(node)
      if (!deep) continue
      visit(node.childNodes)
      if (templates && node.tagName === "template") visit(contentOf(node))
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

/** The nearest composition around an element, not itself: its parent composition. */
function closestComposition(element: Element): Element | undefined {
  let parent = element.parentNode
  while (parent && "tagName" in parent) {
    if (has(parent, "data-composition-id")) return parent
    parent = parent.parentNode
  }
  return undefined
}

/** The text an element holds, such as a `<style>`'s CSS. */
function textOf(element: Element): string {
  return element.childNodes.map((node) => ("value" in node ? node.value : "")).join("")
}

function attribute(element: Element, name: string): string | undefined {
  return element.attrs.find((each) => each.name === name)?.value
}

function has(element: Element, name: string): boolean {
  return element.attrs.some((each) => each.name === name)
}

/** Percent escapes decoded where they are well formed, as a browser reads a path. */
function decodePath(path: string): string {
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

/** A relative path with `.` and `..` resolved; undefined when it is empty or climbs out. */
function normalizePath(path: string): string | undefined {
  const segments: string[] = []
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment !== "..") {
      segments.push(segment)
      continue
    }
    if (segments.length === 0) return undefined
    segments.pop()
  }
  return segments.length > 0 ? segments.join("/") : undefined
}
