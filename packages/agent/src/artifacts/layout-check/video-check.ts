import { posix } from "node:path"
import type { Sandbox } from "@sixb/core"
import type { VideoOutline } from "@sixb/core/artifacts"
import {
  FRAME_CDN_ALLOWLIST,
  HTML_ENTRY,
  injectFrameAssets,
  rewriteFrameReferences,
} from "@sixb/core/internal/artifacts/frames"
import type { ArtifactFrameTarget } from "@sixb/core/storage"
import { loginShellArgs } from "../../login-shell"
import { type AgentSandboxHandle, contextPath } from "../../sandbox-handle"
import { asset, CHECKS_DIRECTORY, type LayoutCheck, type LayoutWarning } from "./layout-check"
import videoScript from "./video.cjs" with { type: "text" }

/** Where the script is, in the run's context directory. */
const LIBRARY = "lib/layout-check"
/**
 * HyperFrames' Chromium start, a check of the whole video, a look at its media, and a frame of
 * each scene's start, middle and end, footage decoded for each: a minute and a half for a teaser,
 * more with footage.
 */
const CHECK_TIMEOUT_MS = 240_000
/** The most frames a check snapshots, whatever the video's length: its contact sheet stays legible. */
const MAX_FRAMES = 24
/** How far into a scene what it brings in has arrived: the guide eases it in over 0.4 to 0.8 s. */
const ARRIVED_MS = 400
/** The most a check reports of HyperFrames' findings; the contact sheet shows the rest. */
const MAX_WARNINGS = 12

/**
 * The craft rules of the guide a check measures, so that no model can read past them: an end card
 * holds three to four seconds, a scene stays long enough to be seen, and a teaser runs at most
 * 45 seconds. Text too small for a phone is HyperFrames' own `text_below_floor`: 2.6% of the short
 * side, 28 px at 1080p.
 */
const CRAFT = {
  /** The last scene, the end card, past three to four seconds and a crossfade. */
  maxEndCardMs: 4_500,
  /** A scene shorter than this flashes by. */
  minSceneMs: 1_000,
  /** The longest a teaser runs, as the guide sets it. */
  maxTeaserMs: 45_000,
  /**
   * A frame is empty under this share of edges: neighbouring pixels of a 192×108 grey copy that
   * differ by more than 24 levels. A line of 48 px text on a plain ground measures about 3%, a
   * busy app screen 10 to 25%, a lone logo on a plain ground 0.5%.
   */
  minInk: 0.01,
}
/**
 * The frames on each contact sheet, as `hyperframes snapshot` pages them: each sheet numbers its
 * own from 1.
 */
export const VIDEO_SHEET_FRAMES = 9
/**
 * What HyperFrames reports that a Sixb video is built to do: scenes that follow one another each
 * leave the root's timeline before it ends.
 */
const EXPECTED = new Set(["subcomposition_blanks_before_host"])

const installed = new WeakSet<Sandbox>()

/**
 * A file of the version, as the check lays the project out: its HTML as a frame serves it, which
 * the export renders; any other where the sandbox holds it; or fetched by the `sixb` arguments
 * given, a recording the version keeps in the API; or left out, saying why.
 */
export type VideoCheckFile =
  | { readonly path: string; readonly html: Uint8Array }
  | { readonly path: string; readonly at: string }
  | { readonly path: string; readonly fetch: readonly string[] }
  | { readonly path: string; readonly missing: string }

/** A frame of the contact sheet: when it shows, and in which scene. */
export interface VideoFrame {
  readonly path: string
  readonly atMs: number
  readonly scene: string
  /** How much it shows, as `CRAFT.minInk` measures it; absent when it could not be measured. */
  readonly ink?: number
}

interface VideoReport {
  readonly layout?: "video"
  readonly findings?: readonly VideoFinding[]
  readonly sheets?: readonly string[]
  readonly frames?: readonly {
    readonly path: string
    readonly time: number
    readonly ink?: number
  }[]
  readonly missing?: readonly { readonly path: string; readonly why: string }[]
  /** What each scene playing at each instant shows of its media, as `mediaProbe` sees it. */
  readonly media?: readonly MediaSample[]
  readonly stopped?: string
  readonly skipped?: string
  readonly failed?: string
}

/** One finding of `hyperframes check`, as its JSON writes it. */
interface VideoFinding {
  readonly code: string
  readonly severity: "error" | "warning" | "info"
  readonly message: string
  readonly fixHint?: string
  readonly text?: string
  /** Seconds into the video where it is first seen. */
  readonly time?: number
  readonly sourceFile?: string
  readonly file?: string
  /** What a request that failed asked for. */
  readonly url?: string
}

/** Why a video or an image cannot be seen at an instant. */
export type MediaHidden = "display" | "visibility" | "opacity" | "size" | "outside"

/** A `<video>` or an `<img>` of a scene playing at an instant, as the page computes it then. */
export interface MediaSight {
  readonly scene: string
  /** Its place among the scene's media the probe looks at: the same element at every instant. */
  readonly index: number
  readonly tag: "video" | "img"
  /** Its `src`, as the scene names it. */
  readonly file: string
  /** When it plays, in seconds from its scene's start, as its `data-start` and `data-duration` say. */
  readonly start: number
  readonly duration?: number
  /** Why it cannot be seen; absent when it can. */
  readonly hidden?: MediaHidden
}

/** What the probe saw at an instant of the check, in seconds. */
export interface MediaSample {
  readonly time: number
  readonly sights: readonly MediaSight[]
}

/**
 * Checks a published video in the sandbox with HyperFrames, the release its export renders with,
 * on the files the export renders: `hyperframes check` for what breaks, overflows, reads poorly or
 * sounds wrong, `mediaProbe` at the snapshot's instants, in the root as the app's frame plays it,
 * for footage never seen while it plays, and `hyperframes snapshot` for a contact sheet of each
 * scene's start, middle and end. A sandbox without HyperFrames skips it; so does a check that
 * fails, which never costs the Agent its publish.
 */
export async function checkVideo(input: {
  readonly handle: AgentSandboxHandle
  readonly files: readonly VideoCheckFile[]
  /** What its HTML embeds from other artifacts, pointed where `files` lends each, as the export does. */
  readonly targets?: readonly ArtifactFrameTarget[]
  readonly outline: VideoOutline
  /** Names the check's directory, so each version's frames stay apart. */
  readonly name: string
  readonly signal: AbortSignal
  /** Test seam; production allows four minutes. */
  readonly timeoutMs?: number
}): Promise<LayoutCheck> {
  const { sandbox } = input.handle
  const timeoutMs = input.timeoutMs ?? CHECK_TIMEOUT_MS
  const library = contextPath(input.handle, LIBRARY)
  const output = contextPath(input.handle, CHECKS_DIRECTORY, input.name)

  const frames = videoInstants(input.outline)
  const decoder = new TextDecoder()
  const html = input.files.flatMap((file) =>
    "html" in file
      ? [
          {
            path: file.path,
            contents: rewriteFrameReferences(
              decoder.decode(file.html),
              input.targets ?? [],
              file.path
            ),
          },
        ]
      : []
  )
  const entry = html.find((file) => file.path === HTML_ENTRY)

  await sandbox.writeFiles([
    ...(installed.has(sandbox)
      ? []
      : [
          { path: posix.join(library, "video.cjs"), contents: videoScript },
          { path: posix.join(library, "video.js"), contents: asset("__sixb/video.js") },
          { path: posix.join(library, "hyperframes.js"), contents: asset("__sixb/hyperframes.js") },
          { path: posix.join(library, "media.js"), contents: `(${mediaProbe.toString()})` },
        ]),
    ...html.map((file) => ({
      path: posix.join(output, "project", file.path),
      contents: file.contents,
    })),
    // The root as the app's frame plays it, which the check seeks to see what its media show.
    ...(entry
      ? [
          {
            path: posix.join(output, "frame.html"),
            contents: injectFrameAssets(entry.contents, "video"),
          },
        ]
      : []),
    {
      path: posix.join(output, "links.json"),
      contents: JSON.stringify(
        Object.fromEntries(
          input.files.flatMap((file) => ("at" in file ? [[file.path, file.at]] : []))
        )
      ),
    },
    {
      path: posix.join(output, "fetches.json"),
      contents: JSON.stringify(
        input.files.flatMap((file) =>
          "fetch" in file ? [{ path: file.path, args: file.fetch }] : []
        )
      ),
    },
    {
      path: posix.join(output, "instants.json"),
      contents: JSON.stringify(
        frames.map((frame) => ({
          at: frame.atMs / 1000,
          scenes: scenesAt(input.outline, frame.atMs).map((scene) => scene.id),
        }))
      ),
    },
  ])
  installed.add(sandbox)

  // The script stops itself first, so it reports what it found and kills its browsers.
  const deadlineMs = Math.floor((timeoutMs * 5) / 6)
  const result = await sandbox.runCommand(
    "bash",
    loginShellArgs(
      'command -v node >/dev/null 2>&1 || { echo \'{"skipped":"no_node"}\'; exit 0; }; exec node "$SIXB_CHECK/video.cjs" "$SIXB_CHECK_OUT" "$SIXB_CHECK_DEADLINE_MS"'
    ),
    {
      env: {
        ...input.handle.env,
        SIXB_CHECK: library,
        SIXB_CHECK_OUT: output,
        SIXB_CHECK_DEADLINE_MS: String(deadlineMs),
      },
      timeout: timeoutMs,
      signal: input.signal,
    }
  )
  input.signal.throwIfAborted()

  const report = parseReport(result.stdout)
  if (report?.skipped) {
    return {
      status: "skipped",
      reason:
        report.skipped === "no_node"
          ? "the sandbox has no Node.js"
          : "the sandbox has no HyperFrames (the agent image has it)",
    }
  }
  if (!report || report.failed || report.layout !== "video") {
    if (result.timedOut) {
      return { status: "skipped", reason: `it took longer than ${timeoutMs / 1000} seconds` }
    }
    const detail = report?.failed ?? result.stderr.trim()
    console.warn(`[SixbAgent] The video check failed: ${detail.slice(0, 500)}`)
    return { status: "skipped", reason: "the check failed in the sandbox" }
  }

  const checks = posix.join(input.handle.contextDirectory, CHECKS_DIRECTORY, input.name)
  const named = (path: string) => posix.join(checks, posix.relative(output, path))
  const shot = new Map((report.frames ?? []).map((frame) => [Math.round(frame.time * 1000), frame]))
  const taken = frames.flatMap((frame) => {
    const snapped = shot.get(frame.atMs)
    if (!snapped) return []
    return [
      {
        ...frame,
        path: named(snapped.path),
        ...(snapped.ink === undefined ? {} : { ink: snapped.ink }),
      },
    ]
  })

  return {
    status: "checked",
    screenshots: (report.sheets ?? []).map(named),
    frames: taken,
    warnings: [
      ...craftWarnings(input.outline, taken),
      ...hiddenMediaWarnings(input.outline, report.media ?? []),
      ...videoWarnings(report.findings ?? [], input.outline),
      // Left out before the check ran, such as a recording whose proxy is still being made, or
      // whose fetch failed in it.
      ...[
        ...input.files.flatMap((file) =>
          "missing" in file ? [{ path: file.path, why: file.missing }] : []
        ),
        ...(report.missing ?? []),
      ].map(({ path, why }) => ({
        code: "video_unchecked_media",
        message: `${path} was not checked, and its frames show without it: ${why.slice(0, 200).replace(/\.$/, "")}.`,
      })),
      ...(report.stopped === undefined
        ? []
        : [
            {
              code: "video_check_incomplete",
              message: `The check stopped early: ${report.stopped.slice(0, 200)}. Run hyperframes check and snapshot on a copy of the video with a longer timeoutMs.`,
            },
          ]),
    ],
  }
}

/**
 * The instants a check snapshots: the first frame, the thumbnail, then each scene's start, once
 * what comes in has come in, its middle, and its end, before it cuts away. Past `MAX_FRAMES`, each
 * scene's middle, and past that, frames spread evenly over the video, so a long one takes as long
 * to check as a teaser.
 *
 * A scene's start is sampled `ARRIVED_MS` in, as the guide brings things in, whatever its length:
 * sooner, a caption that fades in is caught half seen and reads as unreadable. Only a scene too
 * short for it is sampled a third of the way in, before its middle.
 */
export function videoInstants(outline: VideoOutline): Omit<VideoFrame, "path">[] {
  const first = { atMs: 0, scene: sceneAt(outline, 0) }
  return [first, ...sceneInstants(outline, MAX_FRAMES - 1)]
}

function sceneInstants(outline: VideoOutline, most: number): Omit<VideoFrame, "path">[] {
  const { scenes, durationMs } = outline
  const last = Math.max(0, durationMs - 1)

  const each = (atMs: number) => {
    const at = Math.min(last, Math.max(0, Math.round(atMs)))
    return { atMs: at, scene: sceneAt(outline, at) }
  }

  if (scenes.length * 3 <= most) {
    return scenes.flatMap((scene) => {
      const end = scene.startMs + scene.durationMs
      return [
        scene.startMs + Math.min(ARRIVED_MS, scene.durationMs / 3),
        scene.startMs + scene.durationMs / 2,
        end - Math.min(250, scene.durationMs * 0.1),
      ].map((atMs) => ({ atMs: Math.round(atMs), scene: scene.id }))
    })
  }
  if (scenes.length <= most) {
    return scenes.map((scene) => ({
      atMs: Math.round(scene.startMs + scene.durationMs / 2),
      scene: scene.id,
    }))
  }
  return Array.from({ length: most }, (_, index) => each(((index + 0.5) * durationMs) / most))
}

/**
 * What the check measures of the guide's craft: a frame with nothing on it, a scene that flashes
 * by, an end card that lingers, a teaser that runs long. Each names its scene and when.
 */
export function craftWarnings(
  outline: VideoOutline,
  frames: readonly Omit<VideoFrame, "path">[]
): LayoutWarning[] {
  const warnings: LayoutWarning[] = []

  for (const frame of frames) {
    if (frame.ink === undefined || frame.ink >= CRAFT.minInk) continue
    const what = frame.atMs === 0 ? "The first frame, the video's thumbnail," : "The frame"
    warnings.push({
      code: "video_empty_frame",
      part: frame.scene,
      message: `At ${seconds(frame.atMs)}, in scene '${frame.scene}': ${what} is nearly empty. Show the subject from the first frame of each scene: words or the product, never a bare ground or a lone logo.`,
    })
  }

  for (const scene of outline.scenes) {
    if (scene.durationMs >= CRAFT.minSceneMs) continue
    warnings.push({
      code: "video_scene_short",
      part: scene.id,
      message: `At ${seconds(scene.startMs)}, scene '${scene.id}' lasts ${seconds(scene.durationMs)}, too short to be seen: give it a second or more, or fold it into the scene beside it.`,
    })
  }

  // The scene that ends last, which a crossfade into it does not change.
  const end = outline.scenes.reduce<VideoOutline["scenes"][number] | undefined>(
    (latest, scene) =>
      !latest || scene.startMs + scene.durationMs >= latest.startMs + latest.durationMs
        ? scene
        : latest,
    undefined
  )
  if (end && outline.scenes.length > 1 && end.durationMs > CRAFT.maxEndCardMs) {
    warnings.push({
      code: "video_end_card_long",
      part: end.id,
      message: `At ${seconds(end.startMs)}, the end card, scene '${end.id}', holds ${seconds(end.durationMs)}: shorten its host's data-duration to 3 to 4 s, still for the last two.`,
    })
  }

  if (outline.durationMs > CRAFT.maxTeaserMs) {
    warnings.push({
      code: "video_long",
      message: `It runs ${seconds(outline.durationMs)}, past the 45 s a teaser holds: cut it, unless the user asked for this length or it is not a teaser.`,
    })
  }

  return warnings
}

/** How a warning says why a video or an image cannot be seen. */
const HIDDEN: Record<MediaHidden, string> = {
  display: "it or a parent is display: none",
  visibility: "it is visibility: hidden",
  opacity: "its opacity, or a parent's, is 0",
  size: "it has no size",
  outside: "it lies outside the frame",
}

/**
 * A video or an image that is never seen while it plays: at every instant the check sampled while
 * it plays, it was hidden, as `mediaProbe` computed it. A viewer sees what is behind it instead,
 * such as a black phone where the footage should be; the tween that was to bring it in never ran.
 * Each names its scene, its file and when.
 */
export function hiddenMediaWarnings(
  outline: VideoOutline,
  samples: readonly MediaSample[]
): LayoutWarning[] {
  const scenes = new Map(outline.scenes.map((scene) => [scene.id, scene]))
  // Each element, by its scene and place, with what it showed at each instant it plays.
  const media = new Map<
    string,
    { sight: MediaSight; seen: { atMs: number; hidden?: MediaHidden }[] }
  >()

  for (const sample of samples) {
    const atMs = Math.round(sample.time * 1000)

    for (const sight of sample.sights) {
      const scene = scenes.get(sight.scene)
      if (!scene) continue

      // When it plays, within its scene: an instant outside it does not judge it.
      const from = scene.startMs + sight.start * 1000
      const sceneEnd = scene.startMs + scene.durationMs
      const to = sight.duration === undefined ? sceneEnd : from + sight.duration * 1000
      if (atMs < from || atMs >= Math.min(to, sceneEnd)) continue

      const key = `${sight.scene}\0${sight.index}\0${sight.file}`
      const each = media.get(key) ?? { sight, seen: [] }
      each.seen.push({ atMs, ...(sight.hidden ? { hidden: sight.hidden } : {}) })
      media.set(key, each)
    }
  }

  const warnings: LayoutWarning[] = []
  for (const { sight, seen } of media.values()) {
    if (seen.length === 0 || seen.some((at) => at.hidden === undefined)) continue

    const when = list(seen.map((at) => seconds(at.atMs)))
    const why = [...new Set(seen.map((at) => HIDDEN[at.hidden ?? "opacity"]))].join(", then ")
    warnings.push({
      code: "video_media_hidden",
      part: sight.scene,
      message: `At ${when}, in scene '${sight.scene}': the <${sight.tag}> ${sight.file} never shows while it plays: ${why}. Viewers see what is behind it instead. Make sure what brings it in runs within the scene and targets it, or remove it if it is not meant to show.`,
    })
  }
  return warnings.slice(0, MAX_WARNINGS)
}

/**
 * Looks at the `<video>` and `<img>` elements of the scenes playing, the first few of each scene,
 * in a video's page sought to an instant, and says why each cannot be seen, if it cannot: none of
 * it shows, its opacity times its parents' is zero, or it has no size or lies outside the frame.
 * Run in the page as its own source, `(${mediaProbe})(["demo"])`, so it names nothing outside
 * itself. One that starts after another clip, rather than at a time, is left out: when it plays
 * is not known here.
 */
export function mediaProbe(scenes: readonly string[]): MediaSight[] {
  /** The most media of a scene it looks at: footage, then pictures. */
  const MOST = 6
  /** Under this opacity, its own times its parents', it cannot be seen. */
  const MIN_OPACITY = 0.01

  const root = document.querySelector("[data-composition-id]")
  if (!root) return []
  const frame = root.getBoundingClientRect()
  const sights: MediaSight[] = []

  for (const host of Array.from(root.querySelectorAll("[data-composition-src]"))) {
    const scene = host.getAttribute("data-composition-id") ?? ""
    if (!scenes.includes(scene) || host.parentElement?.closest("[data-composition-src]")) continue

    const media = [
      ...Array.from(host.querySelectorAll("video")),
      ...Array.from(host.querySelectorAll("img")),
    ].slice(0, MOST)

    media.forEach((element, index) => {
      // When it plays: while it and each clip it is in play, each timed from its composition's
      // start, which a nested one takes from where it plays in its own.
      const clips: Element[] = []
      for (let node: Element | null = element; node && node !== host; node = node.parentElement) {
        clips.unshift(node)
      }
      let offset = 0
      let start = 0
      let end = Number.POSITIVE_INFINITY
      for (const clip of clips) {
        const at = clip.getAttribute("data-start")
        if (at === null) continue
        const from = offset + Number(at)
        if (!Number.isFinite(from)) return

        const length = Number(clip.getAttribute("data-duration") ?? Number.NaN)
        start = Math.max(start, from)
        if (Number.isFinite(length)) end = Math.min(end, from + length)
        if (clip.hasAttribute("data-composition-id")) offset = from
      }
      if (end <= start) return

      let hidden: MediaHidden | undefined
      let opacity = 1
      for (let node: Element | null = element; node; node = node.parentElement) {
        const style = getComputedStyle(node)
        if (style.display === "none") {
          hidden = "display"
          break
        }
        opacity *= Number(style.opacity)
      }

      const box = element.getBoundingClientRect()
      const outside =
        box.right <= frame.left ||
        box.left >= frame.right ||
        box.bottom <= frame.top ||
        box.top >= frame.bottom
      hidden ??=
        getComputedStyle(element).visibility !== "visible"
          ? "visibility"
          : opacity < MIN_OPACITY
            ? "opacity"
            : box.width < 1 || box.height < 1
              ? "size"
              : outside
                ? "outside"
                : undefined

      const src =
        element.getAttribute("src") ?? element.querySelector("source")?.getAttribute("src") ?? ""
      sights.push({
        scene,
        index,
        tag: element instanceof HTMLVideoElement ? "video" : "img",
        file: src.startsWith("data:") ? "(inline)" : src.replace(/[?#].*$/, ""),
        start,
        ...(Number.isFinite(end) ? { duration: end - start } : {}),
        ...(hidden ? { hidden } : {}),
      })
    })
  }
  return sights
}

/** The scene on screen at an instant: of those that overlap there, the last to start. */
function sceneAt(outline: VideoOutline, atMs: number): string {
  return (scenesAt(outline, atMs).at(-1) ?? outline.scenes.at(-1))?.id ?? ""
}

/** The scenes playing at an instant: two in a crossfade. */
function scenesAt(outline: VideoOutline, atMs: number): VideoOutline["scenes"][number][] {
  return outline.scenes.filter(
    (scene) => scene.startMs <= atMs && atMs < scene.startMs + scene.durationMs
  )
}

/**
 * HyperFrames' findings as warnings, errors first, then by when they are seen: each says when,
 * in which scene, or in which file, what is wrong and how HyperFrames would fix it.
 */
export function videoWarnings(
  findings: readonly VideoFinding[],
  outline: VideoOutline
): LayoutWarning[] {
  // A sandbox without the CDNs fails every request to them, which the app and the export make.
  const offline = findings.filter(unreachable)
  const reported = findings
    .filter(
      (finding) =>
        !unreachable(finding) && finding.severity !== "info" && !EXPECTED.has(finding.code)
    )
    .sort(
      (a, b) =>
        Number(b.severity === "error") - Number(a.severity === "error") ||
        (a.time ?? 0) - (b.time ?? 0)
    )

  const warnings: LayoutWarning[] = reported.slice(0, MAX_WARNINGS).map((finding) => {
    const at = finding.time === undefined ? undefined : Math.round(finding.time * 1000)
    const scene = at === undefined ? undefined : sceneAt(outline, at)
    const file = finding.sourceFile ?? finding.file
    const where =
      at !== undefined && scene
        ? `At ${seconds(at)}, in scene '${scene}'`
        : file
          ? `In ${file.replace(/^.*\/project\//, "")}`
          : "In the video"
    const text = finding.text ? ` (“${oneLine(finding.text).slice(0, 60)}”)` : ""
    const fix = finding.fixHint ? ` ${oneLine(finding.fixHint).slice(0, 300)}` : ""

    return {
      code: `video_${finding.code}`,
      ...(scene ? { part: scene } : {}),
      message: `${where}: ${oneLine(finding.message)}${text}${fix}`,
    }
  })

  const more = reported.length - warnings.length
  if (more > 0) {
    warnings.push({
      code: "video_more",
      message: `${more} more finding${more === 1 ? "" : "s"}; run hyperframes check on the video to see every one.`,
    })
  }

  // First: it explains the script errors that follow it.
  if (offline.length > 0) {
    const hosts = [...new Set(offline.map((finding) => new URL(finding.url ?? "").hostname))]
    const files = offline.length === 1 ? "the file" : `the ${offline.length} files`
    warnings.unshift({
      code: "video_cdn_unreachable",
      message: `This sandbox cannot reach ${hosts.join(", ")}, so the check ran without ${files} the video loads from there: its frames show no motion a library drives and fallback fonts, and a script error that follows is this sandbox's. The app and the export load them: keep them as they are.`,
    })
  }
  return warnings
}

/** A request to a CDN a frame may load from that failed for want of a network, not a file. */
function unreachable(finding: VideoFinding): boolean {
  const { code, url, message } = finding
  return (
    code === "request_failed" &&
    url !== undefined &&
    FRAME_CDN_ALLOWLIST.some((origin) => url.startsWith(`${origin}/`)) &&
    /net::ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|CONNECTION_|ADDRESS_UNREACHABLE|NETWORK_|TIMED_OUT|PROXY_|TUNNEL_)/.test(
      message
    )
  )
}

/** `3.3 s`, as HyperFrames labels its frames. */
function seconds(ms: number): string {
  return `${Number((ms / 1000).toFixed(2))} s`
}

/** `0.4 s, 2 s and 3.75 s`. */
function list(items: readonly string[]): string {
  return items.length < 2
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function parseReport(stdout: string): VideoReport | null {
  const line = stdout.trim().split("\n").at(-1)
  if (!line) return null
  try {
    const value: unknown = JSON.parse(line)
    return typeof value === "object" && value !== null ? (value as VideoReport) : null
  } catch {
    return null
  }
}
