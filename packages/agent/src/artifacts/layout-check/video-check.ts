import { posix } from "node:path"
import type { Sandbox } from "@sixb/core"
import type { VideoOutline } from "@sixb/core/artifacts"
import { FRAME_CDN_ALLOWLIST, rewriteFrameReferences } from "@sixb/core/internal/artifacts/frames"
import { loginShellArgs } from "../../login-shell"
import { type AgentSandboxHandle, contextPath } from "../../sandbox-handle"
import type { LayoutCheck, LayoutWarning } from "./layout-check"
import videoScript from "./video.cjs" with { type: "text" }

/** Where the script is, and each check's files, in the run's context directory. */
const LIBRARY = "lib/layout-check"
const CHECKS = "checks"
/**
 * HyperFrames' Chromium start, a check of the whole video, and a frame of each scene's start,
 * middle and end, footage decoded for each: a minute and a half for a teaser, more with footage.
 */
const CHECK_TIMEOUT_MS = 240_000
/** The most frames a check snapshots, whatever the video's length: its contact sheet stays legible. */
const MAX_FRAMES = 24
/** The most a check reports; the contact sheet shows the rest. */
const MAX_WARNINGS = 12
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
}

interface VideoReport {
  readonly layout?: "video"
  readonly findings?: readonly VideoFinding[]
  readonly sheets?: readonly string[]
  readonly frames?: readonly { readonly path: string; readonly time: number }[]
  readonly missing?: readonly { readonly path: string; readonly why: string }[]
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

/**
 * Checks a published video in the sandbox with HyperFrames, the release its export renders with,
 * on the files the export renders: `hyperframes check` for what breaks, overflows, reads poorly or
 * sounds wrong, and `hyperframes snapshot` for a contact sheet of each scene's start, middle and
 * end. A sandbox without HyperFrames skips it; so does a check that fails, which never costs the
 * Agent its publish.
 */
export async function checkVideo(input: {
  readonly handle: AgentSandboxHandle
  readonly files: readonly VideoCheckFile[]
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
  const output = contextPath(input.handle, CHECKS, input.name)

  const frames = videoInstants(input.outline)
  const decoder = new TextDecoder()
  await sandbox.writeFiles([
    ...(installed.has(sandbox)
      ? []
      : [{ path: posix.join(library, "video.cjs"), contents: videoScript }]),
    ...input.files.flatMap((file) =>
      "html" in file
        ? [
            {
              path: posix.join(output, "project", file.path),
              contents: rewriteFrameReferences(decoder.decode(file.html), [], file.path),
            },
          ]
        : []
    ),
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
      contents: JSON.stringify(frames.map((frame) => frame.atMs / 1000)),
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

  const checks = posix.join(input.handle.contextDirectory, CHECKS, input.name)
  const named = (path: string) => posix.join(checks, posix.relative(output, path))
  const shot = new Map((report.frames ?? []).map((frame) => [Math.round(frame.time * 1000), frame]))

  return {
    status: "checked",
    screenshots: (report.sheets ?? []).map(named),
    frames: frames.flatMap((frame) => {
      const taken = shot.get(frame.atMs)
      return taken ? [{ ...frame, path: named(taken.path) }] : []
    }),
    warnings: [
      ...videoWarnings(report.findings ?? [], input.outline),
      ...(report.missing ?? []).map(({ path, why }) => ({
        code: "video_unchecked_media",
        message: `${path} was not checked, and its frames show without it: ${why.slice(0, 200)}.`,
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
 * The instants a check snapshots: each scene's start, once what comes in has come in, its middle,
 * and its end, before it cuts away. Past `MAX_FRAMES`, each scene's middle, and past that, frames
 * spread evenly over the video, so a long one takes as long to check as a teaser.
 */
export function videoInstants(outline: VideoOutline): Omit<VideoFrame, "path">[] {
  const { scenes, durationMs } = outline
  const last = Math.max(0, durationMs - 1)

  const each = (atMs: number) => {
    const at = Math.min(last, Math.max(0, Math.round(atMs)))
    return { atMs: at, scene: sceneAt(outline, at) }
  }

  if (scenes.length * 3 <= MAX_FRAMES) {
    return scenes.flatMap((scene) => {
      const end = scene.startMs + scene.durationMs
      return [
        scene.startMs + Math.min(400, scene.durationMs * 0.15),
        scene.startMs + scene.durationMs / 2,
        end - Math.min(250, scene.durationMs * 0.1),
      ].map((atMs) => ({ atMs: Math.round(atMs), scene: scene.id }))
    })
  }
  if (scenes.length <= MAX_FRAMES) {
    return scenes.map((scene) => ({
      atMs: Math.round(scene.startMs + scene.durationMs / 2),
      scene: scene.id,
    }))
  }
  return Array.from({ length: MAX_FRAMES }, (_, index) =>
    each(((index + 0.5) * durationMs) / MAX_FRAMES)
  )
}

/** The scene on screen at an instant: of those that overlap there, the last to start. */
function sceneAt(outline: VideoOutline, atMs: number): string {
  const playing = outline.scenes.filter(
    (scene) => scene.startMs <= atMs && atMs < scene.startMs + scene.durationMs
  )
  return (playing.at(-1) ?? outline.scenes.at(-1))?.id ?? ""
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
