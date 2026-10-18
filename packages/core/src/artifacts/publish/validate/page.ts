import type { ArtifactFile } from "../../../storage/artifacts/types"
import { decodeHtmlEntities } from "../../html"
import { ARTIFACT_LIMITS } from "../../limits"
import type { PageOutline } from "../../outline"
import { type ArtifactBlobStorage, invalidArtifact, readArtifactText } from "../files"
import type { FoundReference } from "../references"
import { HTML_ENTRY, readHtmlReferences, refuseFrameAssetPaths } from "./html"

/**
 * Reads a page: `index.html` and the files it loads beside it, its scripts, styles, images, and
 * data. Its `<title>`, else its first `<h1>`, becomes its title in the outline. The `artifact:`
 * addresses it uses are returned to resolve, as a deck's are.
 */
export async function validatePage(
  blobStorage: ArtifactBlobStorage,
  files: readonly ArtifactFile[]
): Promise<{
  readonly entry: string
  readonly outline: PageOutline
  readonly references: readonly FoundReference[]
}> {
  const entry = files.find((file) => file.path === HTML_ENTRY)
  if (!entry) {
    throw invalidArtifact(
      `A page needs '${HTML_ENTRY}', the page itself; put its scripts, styles, and data beside it.`
    )
  }
  refuseFrameAssetPaths(files, "the page")
  const html = await readArtifactText(blobStorage, entry, ARTIFACT_LIMITS.maxPageBytes)

  let title = ""
  let heading = ""
  let readingHeading = false
  const rewriter = new HTMLRewriter()
    .on("title", {
      text(chunk) {
        title += chunk.text
      },
    })
    .on("h1", {
      element(element) {
        if (heading || readingHeading) return
        readingHeading = true
        element.onEndTag(() => {
          readingHeading = false
          heading ||= " "
        })
      },
      text(chunk) {
        if (readingHeading) heading += chunk.text
      },
    })
  const { references, refusal } = readHtmlReferences(rewriter, () => "")
  rewriter.transform(html)

  const refused = refusal()
  if (refused) throw invalidArtifact(refused)
  const plain = (text: string) => decodeHtmlEntities(text).replace(/\s+/g, " ").trim()
  const named = plain(title) || plain(heading)
  return {
    entry: HTML_ENTRY,
    outline: { kind: "page", ...(named ? { title: named.slice(0, 200) } : {}) },
    references,
  }
}
