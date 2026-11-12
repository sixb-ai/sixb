import { createHash } from "node:crypto"
import type { Queue, RenderQueueJob } from "../../queues"
import type {
  ArtifactPdfRecord,
  ArtifactStorage,
  ArtifactVersionRecord,
} from "../../storage/artifacts/types"
import { frameKitDigest } from "./previews"

// A designed document prints to PDF in Chromium, as its stylesheets' @page rule lays it out. The
// PDF is derived data, kept apart from the version by what it prints, its render key, so a version
// restored or frozen as it was keeps its PDF. It is printed when someone asks for it, by the render
// worker in a blank sandbox of the project.

/** How long the worker gives one PDF, how many times it tries, and how long it waits between. */
export const DOCUMENT_PDF_JOB = {
  timeoutMs: 2 * 60_000,
  attempts: 2,
  backoffMs: 15_000,
} as const

/** The largest PDF the worker reads back from its sandbox: past it, the document has none. */
export const MAX_DOCUMENT_PDF_BYTES = 64 * 1024 * 1024

const RENDER_KEY_FORMAT = "sixb-document-pdf/1"

/**
 * What a designed document's PDF is of, as a SHA-256: every file of its version, the frame's kit
 * and runtime it prints with, and its artifact, whose other artifacts' pictures it may show. Null
 * for a version that is not a designed document.
 */
export function documentPdfKey(
  version: Pick<ArtifactVersionRecord, "artifactId" | "files" | "outline">
): string | null {
  if (version.outline.kind !== "document" || version.outline.format !== "html") return null

  const files = version.files
    .map((entry) => [entry.path, entry.file.digest] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return createHash("sha256")
    .update(JSON.stringify([RENDER_KEY_FORMAT, frameKitDigest(), version.artifactId, files]))
    .digest("hex")
}

/**
 * The PDF kept for a version, or why it could not be printed; null when it has neither yet, or is
 * not a designed document.
 */
export async function documentPdf(
  storage: Pick<ArtifactStorage, "getPdf">,
  version: ArtifactVersionRecord
): Promise<ArtifactPdfRecord | null> {
  const renderKey = documentPdfKey(version)
  if (!renderKey) return null
  return storage.getPdf({ projectId: version.projectId, renderKey })
}

/**
 * Asks the render worker to print a designed document's version to PDF, now, forgetting why it
 * could not be printed before.
 */
export async function requestDocumentPdf(
  context: {
    readonly storage: Pick<ArtifactStorage, "clearPdfFailure">
    readonly queue: Pick<Queue<RenderQueueJob>, "enqueue">
  },
  version: ArtifactVersionRecord
): Promise<void> {
  const renderKey = documentPdfKey(version)
  if (!renderKey) return

  await context.storage.clearPdfFailure({ projectId: version.projectId, renderKey })
  await context.queue.enqueue({
    projectId: version.projectId,
    jobs: [
      {
        // One job per artifact: asking again replaces the one still waiting, which names the
        // content asked for last.
        id: `art_pdf_${version.artifactId}`,
        replace: true,
        type: "artifact.pdf.requested",
        payload: { artifactId: version.artifactId, version: version.version, renderKey },
      },
    ],
  })
}
