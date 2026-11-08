import { renderBoardPreviews } from "@sixb/agent"
import type { BlobStorage, FileRef, SandboxFactory, Storage } from "@sixb/core"
import { BOARD_PREVIEW_JOB } from "@sixb/core/internal/artifacts/canvas"
import {
  type ArtifactQueryAnswers,
  missingBoardPreviews,
  parseArtifactQueryAnswers,
  storeBoardPreviews,
} from "@sixb/core/internal/artifacts/publish"
import type { AgentArtifactPreviewsRequestedQueueJob } from "@sixb/core/queues"

// The pictures of a canvas version's boards that nobody rendered: a version a person edited in
// the app, or one whose layout check could not take them. The worker opens a blank sandbox of the
// project, with nothing on its network, renders what is missing there as the Agent's check does,
// and destroys it. Boards that read queries read the answers the job carries: what the version's
// publisher could read when they published it.

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

  // What the boards' queries return, as the version's publisher read them when publishing.
  const queries = job.payload.queries
    ? await queryAnswers(host.blobStorage, job.payload.queries)
    : undefined

  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(BOARD_PREVIEW_JOB.timeoutMs)])
  const sandbox = await host.sandboxes.create({
    environment: {},
    network: { mode: "none" },
    signal,
  })
  try {
    const { previews, dropped } = await renderBoardPreviews({
      sandbox,
      version,
      missing,
      blobStorage: host.blobStorage,
      ...(queries ? { queries } : {}),
      signal,
    })
    const refused = await storeBoardPreviews(
      { storage: artifacts, blobStorage: host.blobStorage },
      version,
      previews
    )
    for (const { board, theme, size, reason } of [...dropped, ...refused]) {
      console.warn(
        `[SixbAgentWorker] The ${size} picture of board '${board}' of '${artifactId}' version ${number} in ${theme} mode was not kept: ${reason}.`
      )
    }
  } finally {
    await sandbox.destroy().catch((error: unknown) => {
      console.error(
        `[SixbAgentWorker] Could not destroy the sandbox that pictured '${artifactId}' version ${number}:`,
        error
      )
    })
  }
}

/**
 * The answers the job carries. Ones that cannot be read leave every query rejecting, as a reader
 * whose queries fail sees the boards.
 */
async function queryAnswers(
  blobStorage: Pick<BlobStorage, "open">,
  file: FileRef
): Promise<ArtifactQueryAnswers | undefined> {
  const text = await new Response(await blobStorage.open(file.blobId)).text()
  const answers = parseArtifactQueryAnswers(text)
  if (!answers)
    console.warn(`[SixbAgentWorker] The query answers in '${file.blobId}' are not answers.`)
  return answers ?? undefined
}
