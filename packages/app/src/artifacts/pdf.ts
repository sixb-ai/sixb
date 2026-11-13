import { printArtifactPdf } from "@sixb/client"
import { DOCUMENT_PDF_WAIT_MS } from "@sixb/core/artifacts"
import { documentPdfUrl } from "./file-source"
import type { ArtifactVersion } from "./queries"

// A designed document's PDF, which the server prints when it is first asked for, with the values
// its fields read as the reader reads them: the download asks until it is ready, a few seconds,
// then saves it. Asking again while it prints asks nothing more. When it could not be printed,
// the download stops there.

const FIRST_CHECK_MS = 1_000
const LONGEST_CHECK_MS = 5_000

/**
 * Asks for the version's PDF, printing it again when it failed before, waits until it is printed,
 * then saves it as the browser downloads a file. Throws when it could not be printed, or is not
 * printed within every attempt the render worker makes.
 */
export async function downloadDocumentPdf(
  version: Pick<ArtifactVersion, "artifactId" | "version">
): Promise<void> {
  const path = { artifactId: version.artifactId, version: String(version.version) }
  const ask = async (query: { retry?: "true"; key?: string }) =>
    (await printArtifactPdf({ path, query, throwOnError: true })).data

  // The first ask prints again a PDF that failed before. A document that shows live data answers
  // with the key of the values it prints, which the rest ask for, though the values change.
  let answer = await ask({ retry: "true" })
  const key = answer.key
  const deadline = Date.now() + DOCUMENT_PDF_WAIT_MS
  let wait = FIRST_CHECK_MS
  while (answer.status !== "ready") {
    if (answer.status === "failed") {
      throw new Error(`[SixbApp] The PDF could not be printed: ${answer.reason}`)
    }
    if (Date.now() + wait > deadline) {
      throw new Error("[SixbApp] The PDF was not printed in time.")
    }
    await new Promise((resolve) => setTimeout(resolve, wait))
    wait = Math.min(wait * 1.5, LONGEST_CHECK_MS)
    answer = await ask(key ? { key } : {})
  }

  const link = document.createElement("a")
  link.href = documentPdfUrl(version, key)
  link.download = ""
  document.body.append(link)
  link.click()
  link.remove()
}
