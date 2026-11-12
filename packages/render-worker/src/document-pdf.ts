import { posix } from "node:path"
import type { FileRef, Sandbox } from "@sixb/core"
import { injectFrameAssets, rewriteFrameReferences } from "@sixb/core/internal/artifacts/frames"
import {
  DOCUMENT_PDF_JOB,
  documentPdfKey,
  MAX_DOCUMENT_PDF_BYTES,
} from "@sixb/core/internal/artifacts/publish"
import type { ArtifactPdfRequestedQueueJob } from "@sixb/core/queues"
import type { ArtifactVersionRecord } from "@sixb/core/storage"
import type { RenderHost } from "./host"
import printScript from "./print.cjs" with { type: "text" }
import { kitFile, RENDER_NETWORK, readBlob, runScript } from "./sandbox"

// A designed document's PDF, which someone asked for: the worker opens a blank sandbox of the
// project, which reaches only the CDNs a frame may load from, writes the version there as its frame
// serves it, prints it with the image's browser, keeps the PDF under the version's render key, and
// destroys the sandbox. When it cannot be printed, why is kept there instead, so whoever is
// waiting for it hears so at once.

/** Where the version is written in the sandbox, beside the script that prints it. */
const SITE = "document"
const SCRIPT = "print.cjs"

/** The frame's own files, which the entry loads from `__sixb/`. */
const KIT = ["__sixb/document.css", "__sixb/runtime.js"]

/**
 * Prints a designed document's version to PDF and keeps it, or why it could not be printed.
 * Repeating it prints nothing more: what an earlier delivery kept is found. A project without
 * sandboxes prints nothing, and neither does a version deleted or whose content changed since it
 * was asked for: asking again asks for what it holds now.
 */
export async function printDocumentPdf(input: {
  readonly host: RenderHost
  readonly job: ArtifactPdfRequestedQueueJob
  readonly signal: AbortSignal
}): Promise<void> {
  const { host, job } = input
  const artifacts = host.storage.artifacts
  if (!artifacts || !host.sandboxes) return

  const { artifactId, version: number, renderKey, document } = job.payload
  const version = await artifacts.getVersion({ projectId: host.id, artifactId, version: number })
  if (!version || documentPdfKey(version, document) !== renderKey) return
  if (await artifacts.getPdf({ projectId: host.id, renderKey })) return

  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(DOCUMENT_PDF_JOB.timeoutMs)])
  const sandbox = await host.sandboxes.create({ environment: {}, network: RENDER_NETWORK, signal })
  try {
    const printed = await print(sandbox, version, document, host.blobStorage, signal)
    await artifacts.putPdf({ projectId: host.id, renderKey, ...printed, createdAt: new Date() })
  } finally {
    await sandbox.destroy().catch((error: unknown) => {
      console.error(
        `[SixbRenderWorker] Could not destroy the sandbox that printed '${artifactId}' version ${number}:`,
        error
      )
    })
  }
}

/**
 * Keeps why a version could not be printed, once the worker gives up on it: whoever is waiting for
 * its PDF hears so. It is kept under what the version printed when asked, so content changed since
 * is printed anew when asked.
 */
export async function failDocumentPdf(input: {
  readonly host: Pick<RenderHost, "id" | "storage">
  readonly job: ArtifactPdfRequestedQueueJob
}): Promise<void> {
  await input.host.storage.artifacts?.putPdf({
    projectId: input.host.id,
    renderKey: input.job.payload.renderKey,
    failure: "Printing it failed. Try again in a moment.",
    createdAt: new Date(),
  })
}

/**
 * Prints the version in `sandbox`, a blank one created for it, with `document` for its entry when
 * given: its markup with the values its fields read written in. Stores the PDF, named after its
 * title. When nothing printed, says why, as whoever asked for it hears it.
 */
async function print(
  sandbox: Sandbox,
  version: ArtifactVersionRecord,
  document: FileRef | undefined,
  blobStorage: RenderHost["blobStorage"],
  signal: AbortSignal
): Promise<{ readonly file: FileRef; readonly pages: number } | { readonly failure: string }> {
  const { outline } = version
  if (outline.kind !== "document" || outline.format !== "html") {
    return { failure: "It is not a designed document." }
  }

  const site = posix.resolve(sandbox.workingDirectory, SITE)
  const script = posix.resolve(sandbox.workingDirectory, SCRIPT)
  const files = await Promise.all(
    version.files.map(async (file) => {
      const entry = file.path === version.entry
      // The markup with the values written in, which it prints instead of its own.
      const bytes = await readBlob(
        blobStorage,
        entry && document ? document.blobId : file.file.blobId
      )
      // The entry as its frame serves it: with the kit, the runtime, and its paper.
      const contents = entry
        ? injectFrameAssets(
            rewriteFrameReferences(new TextDecoder().decode(bytes), [], file.path),
            "document",
            file.path,
            outline.paper
          )
        : bytes
      return { path: posix.join(site, file.path), contents }
    })
  )
  await sandbox.writeFiles([
    ...files,
    ...KIT.map((path) => ({ path: posix.join(site, path), contents: kitFile(path) })),
    { path: script, contents: printScript },
  ])

  // Half its time to print, so it reports why it stopped before the command is killed.
  const deadlineMs = Math.floor(DOCUMENT_PDF_JOB.timeoutMs / 2)
  const { report, stderr } = await runScript(
    sandbox,
    script,
    [site, deadlineMs, MAX_DOCUMENT_PDF_BYTES],
    { timeoutMs: DOCUMENT_PDF_JOB.timeoutMs, signal }
  )
  if (report?.skipped) {
    const why = report.skipped === "no_node" ? "Node.js" : "headless browser"
    return {
      failure: `This project's sandboxes have no ${why} to print with (the agent image has one).`,
    }
  }
  const pages = typeof report?.pages === "number" ? report.pages : 0
  if (typeof report?.pdf !== "string" || pages < 1) {
    const detail = String(report?.failed ?? (stderr || "the browser wrote no PDF"))
    console.warn(
      `[SixbRenderWorker] Version ${version.version} of '${version.artifactId}' was not printed: ${detail.slice(0, 500)}`
    )
    return { failure: "It could not be printed. Try again in a moment." }
  }

  const bytes = Buffer.from(report.pdf, "base64")
  const file = await blobStorage.put({
    body: bytes,
    expectedSizeBytes: bytes.byteLength,
    // The name it downloads as: its title, without what a file name may not hold.
    fileName: `${pdfName(version.title)}.pdf`,
    mediaType: "application/pdf",
  })
  return { file, pages }
}

/** A title as a file name: what one may not hold, and each run of spaces, one space. */
function pdfName(title: string): string {
  const name = [...title]
    .map((char) => (char < " " || '\\/:*?"<>|'.includes(char) ? " " : char))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
  return name || "Document"
}
