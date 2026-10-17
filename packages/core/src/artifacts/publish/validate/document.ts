import { posix } from "node:path"
import type { ArtifactFile } from "../../../storage/artifacts/types"
import { ARTIFACT_LIMITS } from "../../limits"
import { createHeadingSlugger, type DocumentHeading, type DocumentOutline } from "../../outline"
import { type ArtifactBlobStorage, invalidArtifact, readArtifactText } from "../files"

/** The file a document renders from. */
export const DOCUMENT_ENTRY = "document.md"

/**
 * Reads a document's Markdown: its headings become the outline, and every image must be a file in
 * the version, so the document renders the same wherever it is opened.
 */
export async function validateDocument(
  blobStorage: ArtifactBlobStorage,
  files: readonly ArtifactFile[]
): Promise<{ readonly entry: string; readonly outline: DocumentOutline }> {
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
        images.push(decodeHtml(element.getAttribute("src") ?? ""))
      },
    })
    .transform(html)

  const paths = new Set(files.map((file) => file.path))
  for (const source of images) checkImage(source, paths)

  const slug = createHeadingSlugger()
  return {
    entry: DOCUMENT_ENTRY,
    outline: {
      kind: "document",
      headings: headings.map(({ depth, text }): DocumentHeading => {
        const plain = decodeHtml(text).replace(/\s+/g, " ").trim()
        return { depth, text: plain, slug: slug(plain) }
      }),
    },
  }
}

function checkImage(source: string, paths: ReadonlySet<string>): void {
  if (/^artifact:/i.test(source)) {
    throw invalidArtifact(
      `'${source}': showing another artifact in a document is not supported yet.`
    )
  }
  if (source === "" || source.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(source)) {
    throw invalidArtifact(
      `${DOCUMENT_ENTRY} shows the image '${source}'. Images must be files in the artifact: add it to the artifact's folder and refer to it by its relative path.`
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

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: String.fromCharCode(0xa0),
}

/** HTMLRewriter hands over text and attributes as written in the HTML, entities included. */
function decodeHtml(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] !== "#") return NAMED_ENTITIES[entity.toLowerCase()] ?? match
    const codePoint =
      entity[1]?.toLowerCase() === "x"
        ? Number.parseInt(entity.slice(2), 16)
        : Number(entity.slice(1))
    return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : match
  })
}
