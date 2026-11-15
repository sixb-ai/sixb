import { posix } from "node:path"
import type { ArtifactFile } from "../../../storage/artifacts/types"
import { isArtifactAddress } from "../../address"
import { FRAME_CDN_ALLOWLIST } from "../../frames/assets"
import { decodeHtmlEntities } from "../../html"
import { ARTIFACT_LIMITS } from "../../limits"
import { createHeadingSlugger, type DocumentHeading, type DocumentOutline } from "../../outline"
import { readDocumentPaper } from "../../paper"
import { type ArtifactBlobStorage, invalidArtifact, readArtifactText } from "../files"
import type { FoundReference } from "../references"
import { readHtmlReferences, refuseFrameAssetPaths } from "./html"

/** The file a designed document renders from, beside its stylesheets, fonts, and images. */
export const DOCUMENT_HTML_ENTRY = "document.html"

/**
 * What a designed document may not hold: it is read, laid out and printed, never run. A frame
 * would refuse most of them anyway; refusing them here says so to whoever publishes.
 */
const REFUSED_ELEMENTS = [
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "form",
  "base",
  "portal",
  "meta[http-equiv]",
]

/** Attributes that hold an address, which may not run script. */
const ADDRESS_ATTRIBUTES = ["href", "src", "xlink:href", "poster", "action", "formaction"]

/**
 * Reads a designed document: `document.html` and the stylesheets, fonts, and images beside it. It
 * may hold any markup that lays out text, tables, figures, and pictures, styled by any CSS, but
 * nothing that runs: no scripts, no handlers, no frames or forms. Its images are files in the
 * version or another artifact's, and its stylesheets are files in the version or on a CDN the
 * frame loads from. Its headings become the outline, as a Markdown document's do, and the
 * `@page` rule of its stylesheets becomes its paper.
 */
export async function validateHtmlDocument(
  blobStorage: ArtifactBlobStorage,
  files: readonly ArtifactFile[]
): Promise<{
  readonly entry: string
  readonly outline: DocumentOutline
  readonly references: readonly FoundReference[]
}> {
  const entry = files.find((file) => file.path === DOCUMENT_HTML_ENTRY)
  if (!entry) throw invalidArtifact(`A designed document needs '${DOCUMENT_HTML_ENTRY}'.`)
  refuseFrameAssetPaths(files, "the document")
  const html = await readArtifactText(blobStorage, entry, ARTIFACT_LIMITS.maxDocumentBytes)
  const paths = new Set(files.map((file) => file.path))

  let refused: string | undefined
  const refuse = (message: string) => {
    refused ??= message
  }

  const headings: { depth: number; text: string }[] = []
  const slug = createHeadingSlugger()
  const slugs: string[] = []
  let heading: { depth: number; text: string } | null = null
  // The document's styles in the order it applies them: a stylesheet file by its path, or the
  // text of a `<style>` element.
  const styles: ({ readonly path: string } | { readonly css: string })[] = []
  let style: { css: string } | null = null

  const rewriter = new HTMLRewriter()
    .on(REFUSED_ELEMENTS.join(", "), {
      element(element) {
        refuse(
          `${DOCUMENT_HTML_ENTRY} holds <${element.tagName}>. A designed document is laid out and printed, never run: it may not hold scripts, frames, forms, or <base>.`
        )
      },
    })
    .on("*", {
      element(element) {
        for (const [name, value] of element.attributes) {
          const attribute = name.toLowerCase()
          if (attribute.startsWith("on")) {
            refuse(
              `${DOCUMENT_HTML_ENTRY} gives <${element.tagName}> the handler '${name}'. A designed document runs no script.`
            )
          } else if (
            ADDRESS_ATTRIBUTES.includes(attribute) &&
            /^\s*javascript:/i.test(decodeHtmlEntities(value).replace(/[\s\u0000-\u001f]/g, ""))
          ) {
            refuse(
              `${DOCUMENT_HTML_ENTRY} links <${element.tagName}> to a javascript: address. A designed document runs no script.`
            )
          }
        }
      },
    })
    .on("h1, h2, h3, h4, h5, h6", {
      element(element) {
        const current = { depth: Number(element.tagName.slice(1)), text: "" }
        heading = current
        headings.push(current)
        element.onEndTag(() => {
          slugs.push(slug(plainText(current.text)))
          heading = null
        })
      },
      text(chunk) {
        if (heading) heading.text += chunk.text
      },
    })
    .on("img[src]", {
      element(element) {
        const source = decodeHtmlEntities(element.getAttribute("src") ?? "").trim()
        // Another artifact's file is the references' to check.
        if (isArtifactAddress(source)) return
        const problem = localFileProblem(source, paths)
        if (problem) {
          refuse(
            `${DOCUMENT_HTML_ENTRY} shows the image '${source}', ${problem}. Images are files in the artifact, by their relative path, or another artifact's address, such as artifact:art_k3m9q2x7tp/logo.png.`
          )
        }
      },
    })
    .on("link[href]", {
      element(element) {
        const rel = (element.getAttribute("rel") ?? "").toLowerCase().split(/\s+/)
        if (!rel.includes("stylesheet")) return
        const href = decodeHtmlEntities(element.getAttribute("href") ?? "").trim()
        if (FRAME_CDN_ALLOWLIST.some((origin) => href.startsWith(`${origin}/`))) return
        const problem = localFileProblem(href, paths)
        if (problem) {
          refuse(
            `${DOCUMENT_HTML_ENTRY} loads the stylesheet '${href}', ${problem}. A stylesheet is a file in the artifact, by its relative path, or on ${FRAME_CDN_ALLOWLIST.join(", ")}.`
          )
          return
        }
        styles.push({ path: posix.normalize(safeDecodeUri(href.split(/[?#]/)[0] ?? "")) })
      },
    })
    .on("style", {
      element(element) {
        const current = { css: "" }
        style = current
        styles.push(current)
        element.onEndTag(() => {
          style = null
        })
      },
      text(chunk) {
        if (style) style.css += chunk.text
      },
    })
  const { references, refusal } = readHtmlReferences(
    rewriter,
    () => slugs.at(-1) ?? "",
    DOCUMENT_HTML_ENTRY
  )
  rewriter.transform(html)

  const problem = refused ?? refusal()
  if (problem) throw invalidArtifact(problem)

  const stylesheets: string[] = []
  for (const each of styles) {
    if ("css" in each) {
      stylesheets.push(each.css)
      continue
    }
    const file = files.find((candidate) => candidate.path === each.path)
    if (file) {
      stylesheets.push(await readArtifactText(blobStorage, file, ARTIFACT_LIMITS.maxDocumentBytes))
    }
  }
  const paper = readDocumentPaper(stylesheets)

  const outlined = headings.map(
    ({ depth, text }, index): DocumentHeading => ({
      depth,
      text: plainText(text),
      slug: slugs[index] ?? "",
    })
  )
  return {
    entry: DOCUMENT_HTML_ENTRY,
    outline: {
      kind: "document",
      format: "html",
      headings: outlined,
      ...(paper ? { paper } : {}),
    },
    references,
  }
}

function plainText(text: string): string {
  return decodeHtmlEntities(text).replace(/\s+/g, " ").trim()
}

/** Why `source` is not one of the version's files, or null when it is one. */
function localFileProblem(source: string, paths: ReadonlySet<string>): string | null {
  if (source === "" || source.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(source)) {
    return "which is not a file in the artifact"
  }
  const path = posix.normalize(safeDecodeUri(source.split(/[?#]/)[0] ?? ""))
  return paths.has(path) ? null : "which is not one of the artifact's files"
}

function safeDecodeUri(value: string): string {
  try {
    return decodeURI(value)
  } catch {
    return value
  }
}
