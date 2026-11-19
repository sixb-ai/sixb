import {
  BOARD_PREVIEW_JOB,
  DOCUMENT_PDF_JOB,
  MEDIA_JOB,
  VIDEO_EXPORT_JOB,
  VIDEO_SEGMENT_JOB,
  VIDEO_STILLS_JOB,
} from "@sixb/core/internal/artifacts/publish"
import { QueueWorker, type QueueWorkerFailureDecision } from "@sixb/core/internal/workers"
import type { ClaimedQueueJob, Queues, RenderQueueJob } from "@sixb/core/queues"
import { renderBoardPreviews } from "./board-previews"
import { failDocumentPdf, printDocumentPdf } from "./document-pdf"
import type { RenderHost } from "./host"
import { deriveArtifactMedia, failArtifactMedia, mediaAttempts } from "./media"
import type { RenderDownloadHost } from "./sandbox"
import { assembleVideoExport, failVideoExport } from "./video-export"
import { failVideoSegment, renderVideoSegment, segmentName } from "./video-segment"
import { failVideoStills, renderVideoStills } from "./video-stills"

const FAILURE_CODES = ["internal.unexpected", "runtime.cancelled"] as const

/** Two at a time: each render is a sandbox and a browser. */
const DEFAULT_CONCURRENCY = 2

export interface RenderWorkerHost extends RenderHost, RenderDownloadHost {
  readonly storage: RenderHost["storage"] & RenderDownloadHost["storage"]
  readonly blobStorage: RenderHost["blobStorage"] & RenderDownloadHost["blobStorage"]
  readonly queues: Pick<Queues, "renders">
}

export interface RenderWorkerOptions {
  /** Maximum renders this worker runs at once. Defaults to 2. */
  readonly concurrency?: number
}

/**
 * Consumes the `renders` queue: what the framework renders in a blank sandbox of the project, a
 * designed document's PDF, the pictures of a canvas's boards, what is derived of a video or a
 * sound, and a video's stills and MP4, so a render never waits behind an agent's run or takes its
 * slot.
 */
export class RenderWorker extends QueueWorker<RenderQueueJob, typeof FAILURE_CODES> {
  private readonly host: RenderWorkerHost

  constructor(host: RenderWorkerHost, options: RenderWorkerOptions = {}) {
    super({
      projectId: host.id,
      queue: host.queues.renders,
      failureCodes: FAILURE_CODES,
      workerId: `render-worker-${host.id}`,
      claimLimit: options.concurrency ?? DEFAULT_CONCURRENCY,
    })
    this.host = host
  }

  protected async execute(claimed: ClaimedQueueJob<RenderQueueJob>, signal: AbortSignal) {
    const { job } = claimed
    switch (job.type) {
      case "artifact.pdf.requested":
        await printDocumentPdf({ host: this.host, job, signal })
        return
      case "artifact.previews.requested":
        await renderBoardPreviews({ host: this.host, job, signal })
        return
      case "artifact.media.requested":
        await deriveArtifactMedia({ host: this.host, job, signal })
        return
      case "artifact.video.export.requested":
        await assembleVideoExport({ host: this.host, job, signal })
        return
      case "artifact.video.segment.requested":
        await renderVideoSegment({ host: this.host, job, signal })
        return
      case "artifact.video.stills.requested":
        await renderVideoStills({ host: this.host, job, signal })
        return
    }
  }

  protected override async onExecutionError(
    claimed: ClaimedQueueJob<RenderQueueJob>,
    error: unknown
  ): Promise<QueueWorkerFailureDecision<(typeof FAILURE_CODES)[number]>> {
    const { job } = claimed
    const retry = (backoffMs: number) => ({
      kind: "retry" as const,
      availableAt: new Date(Date.now() + backoffMs).toISOString(),
    })

    // What is derived of a media is too: after a few attempts, what is still pending failed, and
    // the file plays as it is.
    if (job.type === "artifact.media.requested") {
      const { file } = job.payload
      console.error(`[SixbRenderWorker] Could not derive '${file.fileName ?? file.digest}'.`, error)
      // Counted in what is kept, across the jobs a lost one is asked for again by.
      const attempts = await mediaAttempts({ host: this.host, job }).catch(() => job.attempt)
      if (attempts < MEDIA_JOB.attempts) return retry(MEDIA_JOB.backoffMs)
      await failArtifactMedia({ host: this.host, job }).catch((failure: unknown) => {
        console.error(
          `[SixbRenderWorker] Could not keep why '${file.digest}' was not derived.`,
          failure
        )
      })
      return { kind: "fail" }
    }

    // A video's segment, or its export: after a few attempts, whoever waits for its MP4 hears
    // which part could not be made, until they ask again.
    if (job.type === "artifact.video.segment.requested") {
      console.error(`[SixbRenderWorker] Could not render ${segmentName(job)}.`, error)
      if (job.attempt < VIDEO_SEGMENT_JOB.attempts) return retry(VIDEO_SEGMENT_JOB.backoffMs)
      await failVideoSegment({ host: this.host, job }).catch((failure: unknown) => {
        console.error(
          `[SixbRenderWorker] Could not keep why ${segmentName(job)} did not render.`,
          failure
        )
      })
      return { kind: "fail" }
    }

    const name = `'${job.payload.artifactId}' version ${job.payload.version}`

    if (job.type === "artifact.video.export.requested") {
      console.error(`[SixbRenderWorker] Could not assemble the MP4 of ${name}.`, error)
      if (job.attempt < VIDEO_EXPORT_JOB.attempts) return retry(VIDEO_EXPORT_JOB.backoffMs)
      await failVideoExport({ host: this.host, job }).catch((failure: unknown) => {
        console.error(`[SixbRenderWorker] Could not keep why ${name} was not assembled.`, failure)
      })
      return { kind: "fail" }
    }

    // Stills are derived: after a few attempts, the scenes show without them.
    if (job.type === "artifact.video.stills.requested") {
      console.error(`[SixbRenderWorker] Could not snapshot the scenes of ${name}.`, error)
      if (job.attempt < VIDEO_STILLS_JOB.attempts) return retry(VIDEO_STILLS_JOB.backoffMs)
      await failVideoStills({ host: this.host, job }).catch((failure: unknown) => {
        console.error(`[SixbRenderWorker] Could not keep why ${name} was not snapshotted.`, failure)
      })
      return { kind: "fail" }
    }

    // Pictures are derived: after a few attempts, the boards keep their outlines.
    if (job.type === "artifact.previews.requested") {
      console.error(`[SixbRenderWorker] Could not picture the boards of ${name}.`, error)
      return job.attempt < BOARD_PREVIEW_JOB.attempts
        ? retry(BOARD_PREVIEW_JOB.backoffMs)
        : { kind: "fail" }
    }

    // A PDF is derived too: after a few attempts, whoever asked hears there is none.
    console.error(`[SixbRenderWorker] Could not print ${name} to PDF.`, error)
    if (job.attempt < DOCUMENT_PDF_JOB.attempts) return retry(DOCUMENT_PDF_JOB.backoffMs)
    await failDocumentPdf({ host: this.host, job }).catch((failure: unknown) => {
      console.error(`[SixbRenderWorker] Could not keep why ${name} did not print.`, failure)
    })
    return { kind: "fail" }
  }
}
