import { renderBoardPreviews } from "@sixb/agent"
import type { BlobStorage, SandboxFactory, Storage } from "@sixb/core"
import {
  boardsReadLiveData,
  missingBoardPreviews,
  storeBoardPreviews,
} from "@sixb/core/internal/artifacts/publish"
import type { AgentArtifactPreviewsRequestedQueueJob } from "@sixb/core/queues"

// The pictures of a canvas version's boards that nobody rendered: a version a person edited in
// the app, or one whose layout check could not take them. The worker opens a blank sandbox of the
// project, with nothing on its network, renders what is missing there as the Agent's check does,
// and destroys it.

/** The sandbox's start, the version's files, and the check's 120 seconds, with room to spare. */
const PREVIEW_JOB_TIMEOUT_MS = 5 * 60_000
/** A job that fails this often stops: its boards show their outlines. */
export const MAX_PREVIEW_ATTEMPTS = 3
/** Before the next attempt: a sandbox that could not start may start a minute later. */
export const PREVIEW_RETRY_BACKOFF_MS = 60_000

export interface ArtifactPreviewsHost {
  readonly id: string
  readonly storage: Pick<Storage, "artifacts">
  readonly blobStorage: Pick<BlobStorage, "put" | "open" | "stat">
  readonly sandboxes?: Pick<SandboxFactory, "create">
}

/**
 * Renders what a version's boards miss and keeps it as their previews. Repeating it renders
 * nothing more: what an earlier delivery kept is no longer missing. A project without sandboxes
 * renders nothing, and neither does a version that was deleted since.
 */
export async function renderArtifactPreviews(input: {
  readonly host: ArtifactPreviewsHost
  readonly job: AgentArtifactPreviewsRequestedQueueJob
  readonly signal: AbortSignal
}): Promise<void> {
  const { host, job } = input
  const artifacts = host.storage.artifacts
  if (!artifacts || !host.sandboxes) return

  const { artifactId, version: number } = job.payload
  const version = await artifacts.getVersion({ projectId: host.id, artifactId, version: number })
  if (!version) return

  const missing = await missingBoardPreviews(artifacts, version)
  if (missing.length === 0) return

  // A board must show its author's rows, and the worker holds no way to read as them: their boards
  // show their outlines until the Agent renders a version of them.
  if (boardsReadLiveData(version)) {
    console.warn(
      `[SixbAgentWorker] The boards of version ${number} of '${artifactId}' read live data, which only their author's own render can show; they keep their outlines.`
    )
    return
  }

  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(PREVIEW_JOB_TIMEOUT_MS)])
  const sandbox = await host.sandboxes.create({
    environment: {},
    network: { mode: "none" },
    signal,
  })
  try {
    const previews = await renderBoardPreviews({
      sandbox,
      version,
      missing,
      blobStorage: host.blobStorage,
      signal,
    })
    await storeBoardPreviews(
      { storage: artifacts, blobStorage: host.blobStorage },
      version,
      previews
    )
  } finally {
    await sandbox.destroy().catch((error: unknown) => {
      console.error(
        `[SixbAgentWorker] Could not destroy the sandbox that pictured '${artifactId}' version ${number}:`,
        error
      )
    })
  }
}
