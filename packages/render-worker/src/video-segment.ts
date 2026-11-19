import { posix } from "node:path"
import type { FileRef } from "@sixb/core"
import {
  VIDEO_ENGINE,
  VIDEO_SEGMENT_SETTINGS,
  videoFrameCount,
  videoSegmentTimeoutMs,
} from "@sixb/core/internal/artifacts/publish"
import type { ArtifactVideoSegmentRequestedQueueJob } from "@sixb/core/queues"
import { inRenderSandbox, renderApiOrigin, storeSandboxFile } from "./sandbox"
import { nudgeVideoExport, type VideoExportHost } from "./video-export"
import { cannotRender, placeVideoProject, runVideoScript } from "./video-project"

// A segment of a video's export, which its export asked for: the frames of one scene, rendered
// alone by HyperFrames from a project that holds that scene and those on screen with it, or the
// whole video's sound, mixed once. The worker opens a blank sandbox of the project that reaches the
// API, lays the project out there, renders, and streams the result back into blob storage under
// the segment's key, which exports that share the segment find.

/** Where the project is laid out in the sandbox, and what the script writes. */
const PROJECT = "video"
const OUT = "segment"
/** Of the time left once the project is laid out: the rest stores what it rendered. */
const RENDER_SHARE = 0.85

/**
 * Renders a segment and keeps it under its key, or why it cannot be rendered: a sandbox without
 * the tools, or with another HyperFrames, is no failure to try again. Repeating it renders nothing
 * more: what an earlier delivery kept is found.
 */
export async function renderVideoSegment(input: {
  readonly host: VideoExportHost
  readonly job: ArtifactVideoSegmentRequestedQueueJob
  readonly signal: AbortSignal
}): Promise<void> {
  const { host, job } = input
  const artifacts = host.storage.artifacts
  if (!artifacts) return

  const { key, segment } = job.payload
  const [kept] = await artifacts.listVideoRenders({ projectId: host.id, keys: [key] })
  if (kept) return

  // Kept, or why not: the export that waits for it looks again at once.
  const keep = async (made: { readonly file: FileRef } | { readonly failure: string }) => {
    await artifacts.putVideoRender({ projectId: host.id, key, createdAt: new Date(), ...made })
    await nudgeVideoExport(host, job.payload.waitingExport)
  }

  if (!host.sandboxes) {
    await keep({ failure: "This project has no sandboxes to render videos in." })
    return
  }

  const made = await inRenderSandbox(
    { sandboxes: host.sandboxes },
    `rendered ${segmentName(job)}`,
    {
      timeoutMs: videoSegmentTimeoutMs(segment, job.payload.video),
      signal: input.signal,
      reach: [renderApiOrigin(host)],
    },
    async (sandbox, left, signal) => {
      const root = posix.resolve(sandbox.workingDirectory, PROJECT)
      await placeVideoProject({
        host,
        sandbox,
        root,
        files: job.payload.files,
        media: job.payload.media,
        timeoutMs: left(),
        signal,
        executionId: job.id,
      })

      const { fps, durationMs } = job.payload.video
      const sound = segment.kind === "sound"
      const out = posix.resolve(sandbox.workingDirectory, `${OUT}.${sound ? "m4a" : "mp4"}`)
      // Part of what is left, so the script says what it made before its command is killed.
      const budget = Math.floor(left() * RENDER_SHARE)
      const frames = job.payload.frames
      const { report, stderr } = sound
        ? await runVideoScript(
            sandbox,
            "sound",
            [root, out, budget, VIDEO_ENGINE, fps, videoFrameCount(durationMs, fps)],
            { timeoutMs: left(), signal }
          )
        : await runVideoScript(
            sandbox,
            "segment",
            [
              root,
              out,
              budget,
              VIDEO_ENGINE,
              fps,
              VIDEO_SEGMENT_SETTINGS.crf,
              VIDEO_SEGMENT_SETTINGS.keyframeSeconds,
              VIDEO_SEGMENT_SETTINGS.workers,
              frames?.from ?? 0,
              frames?.to ?? segment.endFrame - segment.startFrame,
            ],
            { timeoutMs: left(), signal }
          )

      const reason = cannotRender(report)
      if (reason) return { failure: reason }
      if (
        report?.status !== "ready" ||
        typeof report.path !== "string" ||
        typeof report.bytes !== "number"
      ) {
        // Thrown, the job tries again.
        throw new Error(
          `[SixbRenderWorker] Rendering ${segmentName(job)} stopped: ${String(report?.failed ?? (stderr || "the script reported nothing")).slice(0, 500)}`
        )
      }

      const file = await storeSandboxFile(
        host.blobStorage,
        sandbox,
        {
          path: report.path,
          bytes: report.bytes,
          fileName: segment.kind === "sound" ? "sound.m4a" : `${segment.scene}.mp4`,
          mediaType: sound ? "audio/mp4" : "video/mp4",
        },
        { signal }
      )
      return { file }
    }
  )
  await keep(made)
}

/**
 * Keeps why a segment could not be rendered, once the worker gives up on it: every export that
 * waits for it hears so, until someone asks again.
 */
export async function failVideoSegment(input: {
  readonly host: Pick<VideoExportHost, "id" | "storage" | "queues">
  readonly job: ArtifactVideoSegmentRequestedQueueJob
}): Promise<void> {
  const { segment, waitingExport } = input.job.payload
  const artifacts = input.host.storage.artifacts
  if (!artifacts) return

  await artifacts.putVideoRender({
    projectId: input.host.id,
    key: input.job.payload.key,
    failure:
      segment.kind === "sound"
        ? "Its sound could not be mixed. Try again in a moment."
        : `Scene '${segment.label ?? segment.scene}' could not be rendered. Try again in a moment.`,
    createdAt: new Date(),
  })
  await nudgeVideoExport(input.host, waitingExport)
}

/** How logs name a segment: its scene, or the sound, and the version it was asked for. */
export function segmentName(job: ArtifactVideoSegmentRequestedQueueJob): string {
  const { artifactId, version, segment } = job.payload
  const what = segment.kind === "sound" ? "the sound" : `scene '${segment.scene}'`
  return `${what} of '${artifactId}' version ${version}`
}
