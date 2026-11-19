import { posix } from "node:path"
import type { FileRef } from "@sixb/core"
import {
  missingVideoStills,
  playTogether,
  readVideoVersion,
  VIDEO_ENGINE,
  VIDEO_STILL_WIDTH,
  VIDEO_STILLS_JOB,
  videoFrameCount,
  videoSceneFiles,
  videoSegmentIndex,
} from "@sixb/core/internal/artifacts/publish"
import type { ArtifactVideoStillsRequestedQueueJob } from "@sixb/core/queues"
import type { RenderHost } from "./host"
import { inRenderSandbox, renderApiOrigin, storeSandboxFile } from "./sandbox"
import { cannotRender, placeVideoProject, runVideoScript, type VideoHost } from "./video-project"

// The stills of a video version's scenes, asked for when it is published: the worker opens a blank
// sandbox of the project that reaches the API, lays out a project holding the scenes that miss one
// and those on screen with them, and HyperFrames snapshots each at its middle. Each is kept under
// its scene's still key, so a version that keeps a scene keeps its still.

/** Where the project is laid out in the sandbox, and where the script writes the stills. */
const PROJECT = "video"
const OUT = "stills"
/** Of the time left once the project is laid out: the rest stores the stills. */
const SNAPSHOT_SHARE = 0.8

/**
 * Snapshots the stills a version misses and keeps each. A sandbox that cannot render a video keeps
 * why under each, so it is not asked again. Nothing is done for a version deleted, or whose
 * content was written again since it was asked for: that write asks for its own.
 */
export async function renderVideoStills(input: {
  readonly host: VideoHost
  readonly job: ArtifactVideoStillsRequestedQueueJob
  readonly signal: AbortSignal
}): Promise<void> {
  const { host, job } = input
  const artifacts = host.storage.artifacts
  if (!artifacts || !host.sandboxes) return

  const { artifactId, version: number, updatedAt, media } = job.payload
  const version = await artifacts.getVersion({ projectId: host.id, artifactId, version: number })
  if (!version || version.updatedAt.toISOString() !== updatedAt) return
  if (version.outline.kind !== "video") return

  const missing = await missingVideoStills(artifacts, version)
  if (missing.length === 0) return

  // The scenes that hold a missing still, and those on screen with them, where they play.
  const read = await readVideoVersion(host.blobStorage, version.files)
  const { composition } = read
  const wanted = new Set(missing.map((still) => still.scene))
  const kept = composition.scenes
    .filter((scene) =>
      composition.scenes.some((other) => wanted.has(other.id) && playTogether(scene, other))
    )
    .map((scene) => scene.id)
  const text = new TextEncoder().encode(
    videoSegmentIndex(read.index, composition, {
      scenes: kept,
      shiftFrames: 0,
      to: videoFrameCount(composition.durationMs, composition.fps),
    })
  )
  const index = await host.blobStorage.put({
    body: text,
    expectedSizeBytes: text.byteLength,
    fileName: "index.html",
    mediaType: "text/html",
  })
  const files = videoSceneFiles({
    files: version.files,
    composition,
    rootLoads: read.rootLoads,
    loads: read.loads,
    scenes: kept,
    sounds: true,
  }).map((entry) => (entry.path === "index.html" ? { ...entry, file: index } : entry))

  const keep = (key: string, made: { readonly file: FileRef } | { readonly failure: string }) =>
    artifacts.putVideoRender({ projectId: host.id, key, createdAt: new Date(), ...made })

  await inRenderSandbox(
    { sandboxes: host.sandboxes },
    `snapshotted '${artifactId}' version ${number}`,
    { timeoutMs: VIDEO_STILLS_JOB.timeoutMs, signal: input.signal, reach: [renderApiOrigin(host)] },
    async (sandbox, left, signal) => {
      const root = posix.resolve(sandbox.workingDirectory, PROJECT)
      await placeVideoProject({
        host,
        sandbox,
        root,
        files,
        media,
        timeoutMs: left(),
        signal,
        executionId: job.id,
      })

      // HyperFrames snapshots an instant once: a poster may fall on a scene's middle.
      const instants = [...new Set(missing.map((still) => still.atMs))]
      const at = instants.map((ms) => String(ms / 1000))
      const { report, stderr } = await runVideoScript(
        sandbox,
        "stills",
        [
          root,
          posix.resolve(sandbox.workingDirectory, OUT),
          Math.floor(left() * SNAPSHOT_SHARE),
          VIDEO_ENGINE,
          VIDEO_STILL_WIDTH,
          at.join(","),
        ],
        { timeoutMs: left(), signal }
      )

      const reason = cannotRender(report)
      if (reason) {
        for (const still of missing) await keep(still.key, { failure: reason })
        return
      }
      const stills = Array.isArray(report?.stills) ? report.stills : []
      if (stills.length !== instants.length) {
        // Thrown, the job tries again.
        throw new Error(
          `[SixbRenderWorker] Snapshotting '${artifactId}' version ${number} stopped: ${String(report?.failed ?? (stderr || "the script reported nothing")).slice(0, 500)}`
        )
      }

      for (const asked of missing) {
        const still: unknown = stills[instants.indexOf(asked.atMs)]
        if (!isMade(still)) continue
        const file = await storeSandboxFile(
          host.blobStorage,
          sandbox,
          {
            path: still.path,
            bytes: still.bytes,
            fileName: `${asked.scene}-${asked.atMs}.jpg`,
            mediaType: "image/jpeg",
          },
          { signal }
        )
        await keep(asked.key, { file })
      }
    }
  )
}

/**
 * Keeps why each still still missing could not be made, once the worker gives up: the player
 * shows those scenes without one, until they change.
 */
export async function failVideoStills(input: {
  readonly host: Pick<RenderHost, "id" | "storage">
  readonly job: ArtifactVideoStillsRequestedQueueJob
}): Promise<void> {
  const artifacts = input.host.storage.artifacts
  if (!artifacts) return

  const { artifactId, version: number } = input.job.payload
  const version = await artifacts.getVersion({
    projectId: input.host.id,
    artifactId,
    version: number,
  })
  if (!version) return

  for (const still of await missingVideoStills(artifacts, version)) {
    await artifacts.putVideoRender({
      projectId: input.host.id,
      key: still.key,
      failure: "It could not be snapshotted.",
      createdAt: new Date(),
    })
  }
}

function isMade(value: unknown): value is { readonly path: string; readonly bytes: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { path?: unknown }).path === "string" &&
    typeof (value as { bytes?: unknown }).bytes === "number" &&
    (value as { bytes: number }).bytes > 0
  )
}
