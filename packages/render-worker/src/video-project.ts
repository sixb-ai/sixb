import { posix } from "node:path"
import type { ArtifactFile, Sandbox } from "@sixb/core"
import { parseArtifactAddress } from "@sixb/core/artifacts"
import {
  FRAME_REFERENCE_PREFIX,
  rewriteFrameReferences,
} from "@sixb/core/internal/artifacts/frames"
import { VIDEO_ENGINE, type VideoMediaFile } from "@sixb/core/internal/artifacts/publish"
import type { ArtifactFrameTarget } from "@sixb/core/storage"
import type { RenderHost } from "./host"
import {
  downloadIntoSandbox,
  type RenderDownloadHost,
  readBlob,
  runScript,
  scriptFiles,
} from "./sandbox"
import videoScript from "./video.cjs" with { type: "text" }

// A video renders in a sandbox from a HyperFrames project laid out as its version holds it. Its
// HTML is written there as a frame serves it, each `artifact:` address pointed at the file it
// resolved to, lent beside it as a frame lends it; every other file, the footage first, the
// sandbox fetches itself by download URL, so none passes through the worker.

/** What placing a video in a sandbox reads and opens: a render's, and the API's download URLs. */
export type VideoHost = RenderHost & RenderDownloadHost

const SCRIPT = "video.cjs"

/**
 * Lays `files` out in the sandbox under `root`, with the files `media` resolved its `artifact:`
 * addresses to. HTML is written by the worker, its addresses pointed at those files; the sandbox
 * fetches the rest. An address that resolved to nothing loses its file, as a frame shows it.
 */
export async function placeVideoProject(input: {
  readonly host: VideoHost
  readonly sandbox: Sandbox
  readonly root: string
  readonly files: readonly ArtifactFile[]
  readonly media: readonly VideoMediaFile[]
  readonly timeoutMs: number
  readonly signal: AbortSignal
  /** The job that asked, which each download URL names. */
  readonly executionId: string
}): Promise<void> {
  const { host, sandbox, root } = input

  const lent = input.media.flatMap((each) => {
    const address = parseArtifactAddress(each.address)
    if (!each.file || !address?.path) return []

    const target: ArtifactFrameTarget = {
      address: each.address,
      artifactId: address.artifactId,
      version: address.version ?? "latest",
    }
    const path = `${FRAME_REFERENCE_PREFIX}${target.artifactId}@${target.version}/${address.path}`
    return [{ target, path, file: each.file }]
  })
  const targets = lent.map((each) => each.target)

  const pages = input.files.filter((entry) => /\.html?$/i.test(entry.path))
  const written = await Promise.all(
    pages.map(async (entry) => {
      const text = new TextDecoder().decode(await readBlob(host.blobStorage, entry.file.blobId))
      return {
        path: posix.join(root, entry.path),
        contents: rewriteFrameReferences(text, targets, entry.path),
      }
    })
  )
  await sandbox.writeFiles(written)

  const fetched = [
    ...input.files.filter((entry) => !pages.includes(entry)),
    ...lent.map((each) => ({ path: each.path, file: each.file })),
  ]
  await downloadIntoSandbox(
    host,
    sandbox,
    fetched.map((entry) => ({ path: posix.join(root, entry.path), file: entry.file })),
    { timeoutMs: input.timeoutMs, signal: input.signal, executionId: input.executionId }
  )
}

/** Runs `video.cjs` in one of its modes, returning its report, as `runScript` does. */
export async function runVideoScript(
  sandbox: Sandbox,
  mode: "segment" | "sound" | "assemble" | "stills",
  args: readonly (string | number)[],
  options: { readonly timeoutMs: number; readonly signal: AbortSignal }
): Promise<{ readonly report: Record<string, unknown> | null; readonly stderr: string }> {
  await sandbox.writeFiles(scriptFiles(sandbox, SCRIPT, videoScript))
  return runScript(
    sandbox,
    posix.resolve(sandbox.workingDirectory, SCRIPT),
    [mode, ...args],
    options
  )
}

/**
 * Why a sandbox cannot render a video, as whoever asked hears it, from a report that skipped:
 * a tool it lacks, or another HyperFrames than every key names. Null for any other report.
 */
export function cannotRender(report: Record<string, unknown> | null): string | null {
  const skipped = report?.skipped
  if (skipped === "engine") {
    return `This project's sandboxes run ${String(report?.engine)}, and videos render with ${VIDEO_ENGINE}, as the agent image installs it.`
  }
  if (skipped === "no_producer") {
    return `This project's sandboxes run a HyperFrames that cannot mix a video's sound; videos render with ${VIDEO_ENGINE}, as the agent image installs it.`
  }

  const tools: Record<string, string> = {
    no_node: "Node.js",
    no_ffmpeg: "FFmpeg",
    no_hyperframes: "HyperFrames",
  }
  const tool = typeof skipped === "string" ? tools[skipped] : undefined
  return tool
    ? `This project's sandboxes have no ${tool} to render videos with (the agent image has it).`
    : null
}
