import {
  BOARD_PREVIEW_JOB,
  DOCUMENT_PDF_JOB,
  MEDIA_JOB,
} from "@sixb/core/internal/artifacts/publish"
import { QueueWorker, type QueueWorkerFailureDecision } from "@sixb/core/internal/workers"
import type { ClaimedQueueJob, Queues, RenderQueueJob } from "@sixb/core/queues"
import { renderBoardPreviews } from "./board-previews"
import { failDocumentPdf, printDocumentPdf } from "./document-pdf"
import type { RenderHost } from "./host"
import { deriveArtifactMedia, failArtifactMedia } from "./media"
import type { RenderDownloadHost } from "./sandbox"

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
 * designed document's PDF, the pictures of a canvas's boards, and what is derived of a video or a
 * sound, so a render never waits behind an agent's run or takes its slot.
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
      if (job.attempt < MEDIA_JOB.attempts) return retry(MEDIA_JOB.backoffMs)
      await failArtifactMedia({ host: this.host, job }).catch((failure: unknown) => {
        console.error(
          `[SixbRenderWorker] Could not keep why '${file.digest}' was not derived.`,
          failure
        )
      })
      return { kind: "fail" }
    }

    const name = `'${job.payload.artifactId}' version ${job.payload.version}`

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
