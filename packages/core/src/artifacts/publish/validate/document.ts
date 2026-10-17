import { posix } from "node:path"
import type { ArtifactFile } from "../../../storage/artifacts/types"
import { isArtifactAddress } from "../../address"
import { decodeHtmlEntities } from "../../html"
import { ARTIFACT_LIMITS } from "../../limits"
import { createHeadingSlugger, type DocumentHeading, type DocumentOutline } from "../../outline"
import { type ArtifactBlobStorage, invalidArtifact, readArtifactText } from "../files"
import type { FoundReference } from "../references"

/** The file a document renders from. */
export const DOCUMENT_ENTRY = "document.md"

/**
 * Reads a document's Markdown: its headings become the outline, and every image must be a file in
 * the version or an `artifact:` address, so the document renders the same wherever it is opened.
 * The addresses it shows and links to are returned with the section each sits in, to resolve.
 */
export async function validateDocument(
  blobStorage: ArtifactBlobStorage,
  files: readonly ArtifactFile[]
): Promise<{
  readonly entry: string
  readonly outline: DocumentOutline
  readonly references: readonly FoundReference[]
}> {
  const entry = files.find((file) => file.path === DOCUMENT_ENTRY)
  if (!entry) throw invalidArtifact(`A document needs its Markdown in '${DOCUMENT_ENTRY}'.`)
  const markdown = await readArtifactText(blobStorage, entry, ARTIFACT_LIMITS.maxDocumentBytes)

  // The same options the docs site renders with, so headings and images read the same way.
  const html = Bun.markdown.html(markdown, {
    tables: true,
    strikethrough: true,
    tasklists: true,
    autolinks: true,
  })
  const headings: { depth: number; text: string }[] = []
  const images: string[] = []
  // Each address with the index of the heading it follows, -1 before the first.
  const addresses: { address: string; as: "embed" | "link"; heading: number }[] = []
  let heading: { depth: number; text: string } | null = null
  new HTMLRewriter()
    .on("h1, h2, h3, h4, h5, h6", {
      element(element) {
        heading = { depth: Number(element.tagName.slice(1)), text: "" }
        headings.push(heading)
        element.onEndTag(() => {
          heading = null
        })
      },
      text(chunk) {
        if (heading) heading.text += chunk.text
      },
    })
    .on("img", {
      element(element) {
        const source = decodeHtmlEntities(element.getAttribute("src") ?? "")
        if (isArtifactAddress(source)) {
          addresses.push({ address: source.trim(), as: "embed", heading: headings.length - 1 })
        } else {
          images.push(source)
        }
      },
    })
    .on("a", {
      element(element) {
        const href = decodeHtmlEntities(element.getAttribute("href") ?? "")
        if (isArtifactAddress(href)) {
          addresses.push({ address: href.trim(), as: "link", heading: headings.length - 1 })
        }
      },
    })
    .transform(html)

  const paths = new Set(files.map((file) => file.path))
  for (const source of images) checkImage(source, paths)

  const slug = createHeadingSlugger()
  const outlined = headings.map(({ depth, text }): DocumentHeading => {
    const plain = decodeHtmlEntities(text).replace(/\s+/g, " ").trim()
    return { depth, text: plain, slug: slug(plain) }
  })
  return {
    entry: DOCUMENT_ENTRY,
    outline: { kind: "document", headings: outlined },
    references: addresses.map(({ address, as, heading: index }) => ({
      address,
      as,
      at: outlined[index]?.slug ?? "",
    })),
  }
}

function checkImage(source: string, paths: ReadonlySet<string>): void {
  if (source === "" || source.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(source)) {
    throw invalidArtifact(
      `${DOCUMENT_ENTRY} shows the image '${source}'. Images must be files in the artifact, by their relative path, or another artifact's address, such as artifact:art_k3m9q2x7tp#chart=revenue.`
    )
  }
  const path = posix.normalize(safeDecodeUri(source.split(/[?#]/)[0] ?? ""))
  if (!paths.has(path)) {
    throw invalidArtifact(
      `${DOCUMENT_ENTRY} shows the image '${source}', which is not one of the artifact's files.`
    )
  }
}

function safeDecodeUri(value: string): string {
  try {
    return decodeURI(value)
  } catch {
    return value
  }
}
