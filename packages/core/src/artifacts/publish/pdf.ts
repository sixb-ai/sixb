import { createHash } from "node:crypto"
import type { FileRef } from "../../blob-storage/types"
import type { Queue, RenderQueueJob } from "../../queues"
import type { ArtifactStorage, ArtifactVersionRecord } from "../../storage/artifacts/types"
import { frameKitDigest } from "./previews"
import { DOCUMENT_HTML_ENTRY } from "./validate/document-html"

// A designed document prints to PDF in Chromium, as its stylesheets' @page rule lays it out. The
// PDF is derived data, kept apart from the version by what it prints, its render key, so a version
// restored or frozen as it was keeps its PDF. It is printed when someone asks for it, by the render
// worker in a blank sandbox of the project.

export { DOCUMENT_PDF_JOB } from "../pdf-job"

/** The largest PDF the worker reads back from its sandbox: past it, the document has none. */
export const MAX_DOCUMENT_PDF_BYTES = 64 * 1024 * 1024

const RENDER_KEY_FORMAT = "sixb-document-pdf/1"

/**
 * What a designed document's PDF is of, as a SHA-256: every file of its version, the frame's kit
 * and runtime it prints with, and its artifact, whose other artifacts' pictures it may show. Null
 * for a version that is not a designed document. `document` is the `document.html` it prints
 * instead of its own, with the values its fields read written in.
 */
export function documentPdfKey(
  version: Pick<ArtifactVersionRecord, "artifactId" | "files" | "outline">,
  document?: { readonly digest: string }
): string | null {
  if (version.outline.kind !== "document" || version.outline.format !== "html") return null

  const files = version.files
    .map(
      (entry) =>
        [
          entry.path,
          document && entry.path === DOCUMENT_HTML_ENTRY ? document.digest : entry.file.digest,
        ] as const
    )
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return createHash("sha256")
    .update(JSON.stringify([RENDER_KEY_FORMAT, frameKitDigest(), version.artifactId, files]))
    .digest("hex")
}

/**
 * Asks the render worker to print a designed document's version to PDF, with `document` for its
 * `document.html` when given. Asking again while it is asked for asks nothing more; `retry`
 * forgets why it could not be printed before, and asks again.
 */
export async function requestDocumentPdf(
  context: {
    readonly storage: Pick<ArtifactStorage, "clearPdfFailure">
    readonly queue: Pick<Queue<RenderQueueJob>, "enqueue">
  },
  version: ArtifactVersionRecord,
  options: { readonly document?: FileRef; readonly retry?: boolean } = {}
): Promise<void> {
  const renderKey = documentPdfKey(version, options.document)
  if (!renderKey) return

  if (options.retry) {
    await context.storage.clearPdfFailure({ projectId: version.projectId, renderKey })
  }
  await context.queue.enqueue({
    projectId: version.projectId,
    jobs: [
      {
        // One job per PDF: a job still kept answers asking again, unless it is a retry.
        id: `art_pdf_${renderKey}`,
        ...(options.retry ? { replace: true } : {}),
        type: "artifact.pdf.requested",
        payload: {
          artifactId: version.artifactId,
          version: version.version,
          renderKey,
          ...(options.document ? { document: options.document } : {}),
        },
      },
    ],
  })
}
