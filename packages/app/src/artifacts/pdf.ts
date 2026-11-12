import { getArtifactVersion, printArtifactPdf } from "@sixb/client"
import { documentPdfUrl } from "./file-source"
import type { ArtifactVersion } from "./queries"

// A designed document's PDF, which the server prints when it is first asked for: the download asks
// once, watches the version until it says its PDF is ready, a few seconds, then saves it. When it
// could not be printed, the version says so, and the download stops there.

/** How long a download waits for its PDF before it gives up. */
const PRINT_WAIT_MS = 2 * 60_000
const FIRST_CHECK_MS = 1_000
const LONGEST_CHECK_MS = 5_000

/**
 * Asks for the version's PDF, printing it again when it failed before, waits until it is printed,
 * then saves it as the browser downloads a file. Throws when it could not be printed, or takes
 * longer than two minutes.
 */
export async function downloadDocumentPdf(
  version: Pick<ArtifactVersion, "artifactId" | "version">
): Promise<void> {
  const path = { artifactId: version.artifactId, version: String(version.version) }
  const { data } = await printArtifactPdf({ path, query: { retry: "true" }, throwOnError: true })

  // Asked once: the version says when its PDF is ready, and asking again would print it again.
  let status = data.status === "ready" ? "ready" : "printable"
  const deadline = Date.now() + PRINT_WAIT_MS
  let wait = FIRST_CHECK_MS
  while (status !== "ready") {
    if (status === "failed") throw await notPrinted(path)
    if (Date.now() + wait > deadline) {
      throw new Error("[SixbApp] The PDF was not printed within two minutes.")
    }
    await new Promise((resolve) => setTimeout(resolve, wait))
    wait = Math.min(wait * 1.5, LONGEST_CHECK_MS)
    const read = await getArtifactVersion({ path, throwOnError: true })
    status = read.data.pdf ?? "printable"
  }

  const link = document.createElement("a")
  link.href = documentPdfUrl(version)
  link.download = ""
  document.body.append(link)
  link.click()
  link.remove()
}

/** Why the PDF could not be printed, as asking for it without printing it again says. */
async function notPrinted(path: { readonly artifactId: string; readonly version: string }) {
  const { data } = await printArtifactPdf({ path, throwOnError: true })
  return new Error(
    data.status === "failed"
      ? `[SixbApp] The PDF could not be printed: ${data.reason}`
      : "[SixbApp] The PDF could not be printed."
  )
}
