import { posix } from "node:path"
import type { ArtifactFile, Queues } from "@sixb/core"
import {
  readVideoVersion,
  VIDEO_EXPORT_JOB,
  type VideoExportPlan,
  type VideoMediaFile,
  type VideoVersionRead,
  videoExportJobId,
  videoExportKeys,
  videoExportPlan,
  videoExportStatus,
  videoSceneFiles,
  videoSegmentIndex,
  videoSegmentJobId,
  videoSegmentRender,
  videoSoundProject,
} from "@sixb/core/internal/artifacts/publish"
import type {
  ArtifactVideoExportRequestedQueueJob,
  ArtifactVideoSegmentRequestedQueueJob,
  NewQueueJob,
} from "@sixb/core/queues"
import type { ArtifactVideoRenderLack, ArtifactVideoRenderRecord } from "@sixb/core/storage"
import type { RenderHost } from "./host"
import {
  downloadIntoSandbox,
  inRenderSandbox,
  readBlob,
  renderApiOrigin,
  storeSandboxFile,
  titleFileName,
} from "./sandbox"
import { runVideoScript, type VideoHost } from "./video-project"

// A video version's MP4, which someone asked for. Its job looks at what is kept under its
// segments' keys: it asks for each segment still missing, in a job of its own, and looks again a
// few seconds later, in a job it asks for in its own place, rather than waiting in a worker. Once
// every segment is rendered, it opens a blank sandbox of the project that reaches the API, fetches
// them there, joins them without encoding them again, with the sound, and keeps the MP4 under the
// export's key. A segment that failed fails the export, saying which.

/** What assembling an export reads, opens, keeps, and asks for. */
export type VideoExportHost = VideoHost & { readonly queues: Pick<Queues, "renders"> }

/** Where the segments are fetched to in the sandbox, and the MP4 written. */
const PARTS = "export"
const MP4 = "export.mp4"
/** Of the time left once the segments are fetched: the rest stores the MP4. */
const JOIN_SHARE = 0.5

/**
 * Assembles an export once its segments are rendered, asking for those still missing until then.
 * Repeating it assembles nothing more: what an earlier delivery kept is found.
 */
export async function assembleVideoExport(input: {
  readonly host: VideoExportHost
  readonly job: ArtifactVideoExportRequestedQueueJob
  readonly signal: AbortSignal
}): Promise<void> {
  const { host, job } = input
  const artifacts = host.storage.artifacts
  if (!artifacts) return

  const { payload } = job
  const plan = videoExportPlan(payload)
  if (plan.key !== payload.key) {
    // Thrown, the job tries again, as a deploy may be rolling out: once its attempts are spent,
    // failVideoExport keeps why, and asking again asks anew.
    throw new Error(
      `[SixbRenderWorker] The export of ${exportName(job)} was asked for by another version of Sixb, whose keys differ from this worker's.`
    )
  }

  const kept = await artifacts.listVideoRenders({ projectId: host.id, keys: videoExportKeys(plan) })
  const status = videoExportStatus(plan, kept)
  const fail = (failure: string, lacks?: ArtifactVideoRenderLack) =>
    artifacts.putVideoRender({
      projectId: host.id,
      key: plan.key,
      failure,
      ...(lacks ? { lacks } : {}),
      createdAt: new Date(),
    })

  if (status.status === "ready") return
  if (status.status === "failed") {
    // A segment's failure is the export's, until someone asks again.
    if (!kept.some((record) => record.key === plan.key)) await fail(status.reason, status.lacks)
    return
  }
  if (!host.sandboxes) {
    await fail("This project has no sandboxes to render videos in.", "sandboxes")
    return
  }

  if (payload.retry) {
    // Apart from the export's own job, which a segment that finishes takes the place of, asking
    // for nothing: the retry asks for what is missing, and the export looks at once.
    if (!status.progress.assembling) await askForSegments(host, job, plan, kept)
    await lookAgain(host, job, plan, 0)
    return
  }

  if (!status.progress.assembling) {
    if (Date.now() - Date.parse(payload.askedAt) > VIDEO_EXPORT_JOB.waitMs) {
      await fail("It took too long to render. Try again.")
      return
    }
    if (!payload.waiting) await askForSegments(host, job, plan, kept)
    await lookAgain(host, job, plan)
    return
  }

  const segments = plan.segments.map((segment) => {
    const record = kept.find((each) => each.key === segment.key)
    if (!record || "failure" in record)
      throw new Error(`[SixbRenderWorker] Segment '${segment.key}' is gone.`)
    return { kind: segment.kind, file: record.file }
  })

  const file = await inRenderSandbox(
    { sandboxes: host.sandboxes },
    `assembled ${exportName(job)}`,
    { timeoutMs: VIDEO_EXPORT_JOB.timeoutMs, signal: input.signal, reach: [renderApiOrigin(host)] },
    async (sandbox, left, signal) => {
      const at = (index: number, kind: string) =>
        posix.resolve(
          sandbox.workingDirectory,
          PARTS,
          kind === "sound" ? "sound.m4a" : `${String(index).padStart(4, "0")}.mp4`
        )
      const placed = segments.map((segment, index) => ({
        path: at(index, segment.kind),
        file: segment.file,
      }))
      await downloadIntoSandbox(host, sandbox, placed, {
        timeoutMs: left(),
        signal,
        executionId: job.id,
      })

      const mp4 = posix.resolve(sandbox.workingDirectory, MP4)
      const sound = placed.find((_, index) => segments[index]?.kind === "sound")?.path ?? ""
      const pictures = placed.filter((_, index) => segments[index]?.kind === "scene")
      const { report, stderr } = await runVideoScript(
        sandbox,
        "assemble",
        [
          mp4,
          Math.floor(left() * JOIN_SHARE),
          plan.frames,
          payload.outline.fps,
          sound,
          ...pictures.map((each) => each.path),
        ],
        { timeoutMs: left(), signal }
      )
      if (report?.status !== "ready" || typeof report.bytes !== "number") {
        // Thrown, the job tries again.
        throw new Error(
          `[SixbRenderWorker] Assembling ${exportName(job)} stopped: ${String(report?.failed ?? report?.skipped ?? (stderr || "the script reported nothing")).slice(0, 500)}`
        )
      }

      return storeSandboxFile(
        host.blobStorage,
        sandbox,
        {
          path: mp4,
          bytes: report.bytes,
          fileName: `${titleFileName(payload.title, "Video")}.mp4`,
          mediaType: "video/mp4",
        },
        { signal }
      )
    }
  )
  await artifacts.putVideoRender({ projectId: host.id, key: plan.key, file, createdAt: new Date() })
}

/**
 * Keeps why an export could not be assembled, once the worker gives up on it: whoever waits for it
 * hears so, until they ask again.
 */
export async function failVideoExport(input: {
  readonly host: Pick<RenderHost, "id" | "storage">
  readonly job: ArtifactVideoExportRequestedQueueJob
}): Promise<void> {
  const { payload } = input.job
  const matches = videoExportPlan(payload).key === payload.key
  await input.host.storage.artifacts?.putVideoRender({
    projectId: input.host.id,
    key: payload.key,
    failure: matches
      ? "It could not be put together. Try again in a moment."
      : "It was asked for while Sixb was being updated. Try again.",
    createdAt: new Date(),
  })
}

/**
 * Asks the export that waits for a segment to look again at once, as the segment is kept or
 * failed: it joins the MP4 without waiting for its next look, `VIDEO_EXPORT_JOB.recheckMs`, which
 * stays for the exports that share the segment. A look that runs then replaces this one. A retry
 * runs in a job of its own, which this never replaces.
 */
export async function nudgeVideoExport(
  host: Pick<VideoExportHost, "id" | "queues">,
  waiting: ArtifactVideoExportRequestedQueueJob["payload"] | undefined
): Promise<void> {
  if (!waiting) return

  await host.queues.renders.enqueue({
    projectId: host.id,
    jobs: [
      {
        id: videoExportJobId(waiting.key),
        replace: true,
        type: "artifact.video.export.requested",
        payload: waiting,
      },
    ],
  })
}

/**
 * Asks for each segment still missing. A segment job keeps what it rendered or why it could not,
 * so one asked for before is either waiting, running, or kept: asking again changes nothing,
 * unless this is a retry, which asks anew for one whose failure was forgotten.
 */
async function askForSegments(
  host: VideoExportHost,
  job: ArtifactVideoExportRequestedQueueJob,
  plan: VideoExportPlan,
  kept: readonly ArtifactVideoRenderRecord[]
): Promise<void> {
  const { payload } = job
  const done = new Set(kept.map((record) => record.key))
  const missing = plan.segments.filter((segment) => !done.has(segment.key))

  // The composition is read only when a scene is missing: the sound reads its pages alone.
  const read = missing.some((segment) => segment.kind === "scene")
    ? await readVideoVersion(host.blobStorage, payload.files)
    : null
  const video = {
    width: payload.outline.width,
    height: payload.outline.height,
    fps: payload.outline.fps,
    durationMs: payload.outline.durationMs,
  }

  // What each segment hands back once kept, so this export looks again at once.
  const { retry: _retry, ...asked } = payload
  const waitingExport = { ...asked, waiting: true }

  const jobs: NewQueueJob<ArtifactVideoSegmentRequestedQueueJob>[] = []
  for (const { key, ...segment } of missing) {
    const common = {
      artifactId: payload.artifactId,
      version: payload.version,
      key,
      segment,
      video,
      waitingExport,
    }
    const project =
      segment.kind === "scene" && read
        ? await sceneProject(host, read, payload, segment)
        : await soundProject(host, payload)
    jobs.push({
      id: videoSegmentJobId(key),
      ...(payload.retry ? { replace: true } : {}),
      type: "artifact.video.segment.requested",
      payload: { ...common, ...project },
    })
  }

  await host.queues.renders.enqueue({ projectId: host.id, jobs })
}

/**
 * Asks for this export again, `VIDEO_EXPORT_JOB.recheckMs` from now unless said, in the export's
 * own place, which it holds: the id waits as the new job once this one is settled. It only looks
 * whether the segments are rendered.
 */
async function lookAgain(
  host: VideoExportHost,
  job: ArtifactVideoExportRequestedQueueJob,
  plan: VideoExportPlan,
  inMs: number = VIDEO_EXPORT_JOB.recheckMs
): Promise<void> {
  const { retry: _retry, ...payload } = job.payload
  await host.queues.renders.enqueue({
    projectId: host.id,
    jobs: [
      {
        id: videoExportJobId(plan.key),
        replace: true,
        type: "artifact.video.export.requested",
        payload: { ...payload, waiting: true },
        availableAt: new Date(Date.now() + inMs).toISOString(),
      },
    ],
  })
}

/**
 * What a scene's segment renders from: `index.html` keeping the scenes on screen with it, stored
 * for the segment's job, and the files their frames are made of, with their sounds, which
 * HyperFrames loads; what the root and those scenes play from other artifacts.
 */
async function sceneProject(
  host: VideoExportHost,
  read: VideoVersionRead,
  payload: ArtifactVideoExportRequestedQueueJob["payload"],
  segment: { readonly scene: string; readonly startFrame: number; readonly endFrame: number }
): Promise<{
  readonly files: readonly ArtifactFile[]
  readonly media: readonly VideoMediaFile[]
  readonly frames: { readonly from: number; readonly to: number }
}> {
  const render = videoSegmentRender(read.composition, segment, read.rootTimeline)
  const text = new TextEncoder().encode(videoSegmentIndex(read.index, read.composition, render))
  const index = await host.blobStorage.put({
    body: text,
    expectedSizeBytes: text.byteLength,
    fileName: "index.html",
    mediaType: "text/html",
  })

  const files = videoSceneFiles({
    files: payload.files,
    composition: read.composition,
    rootLoads: read.rootLoads,
    loads: read.loads,
    scenes: render.scenes,
    sounds: true,
  }).map((entry) => (entry.path === "index.html" ? { ...entry, file: index } : entry))

  const at = new Set(["", ...render.scenes])
  const played = new Set(
    payload.references.filter((each) => at.has(each.at)).map((each) => each.address)
  )
  return {
    files,
    media: payload.media.filter((each) => played.has(each.address)),
    frames: { from: render.from, to: render.to },
  }
}

/**
 * What the sound mixes from: the version's pages, each muted video's sources cut and stored for the
 * sound's job, and every other file but the videos nothing heard plays, which it never fetches.
 */
async function soundProject(
  host: VideoExportHost,
  payload: ArtifactVideoExportRequestedQueueJob["payload"]
): Promise<{ readonly files: readonly ArtifactFile[]; readonly media: readonly VideoMediaFile[] }> {
  const html = payload.files.filter((entry) => /\.html?$/i.test(entry.path))
  const read = async (entry: ArtifactFile) =>
    new TextDecoder().decode(await readBlob(host.blobStorage, entry.file.blobId))
  const pages = new Map(
    await Promise.all(html.map(async (entry) => [entry.path, await read(entry)] as const))
  )

  const sound = videoSoundProject({ files: payload.files, pages, media: payload.media })
  const files = await Promise.all(
    sound.files.map(async (entry) => {
      const text = sound.pages.get(entry.path)
      if (text === undefined) return entry

      const body = new TextEncoder().encode(text)
      const file = await host.blobStorage.put({
        body,
        expectedSizeBytes: body.byteLength,
        fileName: posix.basename(entry.path),
        mediaType: "text/html",
      })
      return { ...entry, file }
    })
  )
  return { files, media: sound.media }
}

/** How logs name an export: its artifact and version. */
function exportName(job: ArtifactVideoExportRequestedQueueJob): string {
  return `'${job.payload.artifactId}' version ${job.payload.version}`
}
