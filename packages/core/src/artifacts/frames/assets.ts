import type {
  ArtifactFile,
  ArtifactFrameTarget,
  ArtifactMediaRecord,
} from "../../storage/artifacts/types"
import { isArtifactAddress, parseArtifactAddress } from "../address"
import { decodeHtmlEntities, HTML_FILE_ATTRIBUTES } from "../html"
import { mediaProxyReference } from "../media/media"
import type { DocumentHeading } from "../outline"
import type { DocumentPaper } from "../paper"
import { FRAME_ASSET_PREFIX } from "../publish/validate/html"
import { videoFilePath } from "../video/composition"
import { documentData } from "./document-data"
import type { FrameLayout } from "./entries"
import { HYPERFRAMES_RUNTIME } from "./hyperframes"
import { FRAME_DECK_CSS, FRAME_DOCUMENT_CSS, FRAME_PAGE_CSS } from "./kit"
import { frameRuntime } from "./runtime"

/**
 * Hosts a frame may load from besides its own files: CSS and script libraries and web fonts, Google
 * Fonts among them. Each is a public CDN; a frame that uses one contacts it when it opens, and a
 * sandbox that pictures a canvas's boards reaches them alone.
 */
export const FRAME_CDN_ALLOWLIST = [
  "https://cdn.jsdelivr.net",
  "https://cdnjs.cloudflare.com",
  "https://unpkg.com",
  "https://fonts.googleapis.com",
  "https://fonts.gstatic.com",
] as const

/**
 * The files a frame gets besides the version's own, under `__sixb/`, which a version may not use:
 * a kit per layout, the runtime, and the HyperFrames runtime a video plays with. The server serves
 * them to the app's frames, and the Agent's layout check serves them to its browser, so both lay a
 * version out the same way. Their bodies are in every render key (`frameKitDigest`), so a new
 * HyperFrames release renders every video again.
 */
export const FRAME_ASSETS: Readonly<
  Record<string, { readonly body: string; readonly type: string }>
> = {
  [`${FRAME_ASSET_PREFIX}deck.css`]: { body: FRAME_DECK_CSS, type: "text/css; charset=utf-8" },
  [`${FRAME_ASSET_PREFIX}page.css`]: { body: FRAME_PAGE_CSS, type: "text/css; charset=utf-8" },
  [`${FRAME_ASSET_PREFIX}document.css`]: {
    body: FRAME_DOCUMENT_CSS,
    type: "text/css; charset=utf-8",
  },
  [`${FRAME_ASSET_PREFIX}runtime.js`]: {
    body: `(${frameRuntime.toString()})(${documentData.toString()})\n`,
    type: "text/javascript; charset=utf-8",
  },
  [`${FRAME_ASSET_PREFIX}hyperframes.js`]: {
    body: HYPERFRAMES_RUNTIME,
    type: "text/javascript; charset=utf-8",
  },
}

/**
 * The kit for the layout and the runtime, which reads the layout from its own tag, and a designed
 * document's paper: its width, height, and margins, top, right, bottom and left, in pixels.
 *
 * A video gets no kit: its scenes show as HyperFrames renders them, so what the app plays is what
 * an export renders. HyperFrames' runtime comes right after ours, before the scenes' scripts, as
 * its own player puts it.
 */
function injected(layout: FrameLayout, base: string, paper?: DocumentPaper): string {
  const runtime = `<script src="${base}${FRAME_ASSET_PREFIX}runtime.js" data-sixb-layout="${layout}"`
  if (layout === "video") {
    return `${runtime}></script><script src="${base}${FRAME_ASSET_PREFIX}hyperframes.js"></script>`
  }

  const sheet = paper
    ? ` data-sixb-paper="${[paper.width, paper.height, paper.margin.top, paper.margin.right, paper.margin.bottom, paper.margin.left].join(" ")}"`
    : ""
  return `<link rel="stylesheet" href="${base}${FRAME_ASSET_PREFIX}${layout}.css">${runtime}${sheet}></script>`
}

/**
 * The way from an entry back to its frame's root, where `__sixb/` is: none for `index.html`,
 * `../` for a canvas's `boards/home.html`.
 */
function rootOf(entry: string): string {
  return "../".repeat(entry.split("/").length - 1)
}

/**
 * An entry with its layout's kit and the runtime first in its `<head>`, before anything of its
 * own, so its styles and scripts build on them. Exactly once, whatever the markup: in `<head>`
 * when the page has one, else first in `<html>`, else right after the doctype, so a page without
 * either still renders in standards mode. Each element is looked for by parsing, not by matching
 * text, so a `<head>` inside a comment or a script's string is not one. `entry` is where the page
 * is in the version, so an entry in a folder, as a canvas's boards are, finds them.
 */
export function injectFrameAssets(
  html: string,
  layout: FrameLayout,
  entry = "index.html",
  paper?: DocumentPaper
): string {
  const assets = injected(layout, rootOf(entry), paper)
  for (const selector of ["head", "html"]) {
    let injected = false
    const rewritten = new HTMLRewriter()
      .on(selector, {
        element(element) {
          if (injected) return
          injected = true
          element.prepend(assets, { html: true })
        },
      })
      .transform(html)
    if (injected) return rewritten
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)?.[0] ?? ""
  return `${doctype}${assets}${html.slice(doctype.length)}`
}

/**
 * Marks each heading of a designed document with the slug publishing named it by, in order,
 * `data-sixb-section`, so the frame opens the document at the section an address names.
 */
export function markDocumentSections(html: string, headings: readonly DocumentHeading[]): string {
  let index = 0
  return new HTMLRewriter()
    .on("h1, h2, h3, h4, h5, h6", {
      element(element) {
        const heading = headings[index]
        index += 1
        if (heading?.slug) element.setAttribute("data-sixb-section", heading.slug)
      },
    })
    .transform(html)
}

/**
 * Where a frame serves a file another artifact lends it, at the version its address pins or the
 * latest: `__sixb/ref/<id>@<version>/<path>` or `__sixb/ref/<id>@latest/<path>`.
 */
export const FRAME_REFERENCE_PREFIX = `${FRAME_ASSET_PREFIX}ref/`

/** A lent file's path under {@link FRAME_REFERENCE_PREFIX}: its artifact, version, and path. */
export const FRAME_REFERENCE_PATH = /^([^/@]+)@(\d+|latest)\/(.+)$/

/** The path, from an entry, of a file one of its frame's targets lends it. */
function frameReferencePath(target: ArtifactFrameTarget, entry: string): string | null {
  const file = parseArtifactAddress(target.address)?.path
  if (!file) return null
  const path = file.split("/").map(encodeURIComponent).join("/")
  return `${rootOf(entry)}${FRAME_REFERENCE_PREFIX}${target.artifactId}@${target.version}/${path}`
}

/**
 * Points each file an entry shows or plays from another artifact (`<img src="artifact:…">`, a
 * `<video>`'s source or poster, an `<audio>`'s, a `<source>`'s, a `<track>`'s captions) at the
 * copy its frame serves, marked `data-sixb-ref`. A file its reader cannot see, or that the frame
 * has no target for, loses its attribute and is marked unavailable: the kit draws an image or a
 * video as an empty box. Addresses are compared as publishing recorded them, with their entities
 * decoded.
 */
export function rewriteFrameReferences(
  html: string,
  targets: readonly ArtifactFrameTarget[],
  entry = "index.html"
): string {
  const rewriter = new HTMLRewriter()
  for (const { element: tag, attribute } of HTML_FILE_ATTRIBUTES) {
    rewriter.on(`${tag}[${attribute}]`, {
      element(element) {
        const source = decodeHtmlEntities(element.getAttribute(attribute) ?? "").trim()
        if (!isArtifactAddress(source)) return
        const target = targets.find((candidate) => candidate.address === source)
        const path = target ? frameReferencePath(target, entry) : null
        if (path) {
          element.setAttribute(attribute, path)
          // A `<video>` names two files: either one unavailable marks it.
          if (element.getAttribute("data-sixb-ref") !== "unavailable") {
            element.setAttribute("data-sixb-ref", "")
          }
        } else {
          element.removeAttribute(attribute)
          element.setAttribute("data-sixb-ref", "unavailable")
        }
      },
    })
  }
  return rewriter.transform(html)
}

/**
 * Points each recording a video's HTML file plays, a `<video>`'s, an `<audio>`'s or a
 * `<source>`'s, at its proxy once one is ready: the path as written, with the proxy's name in its
 * query, as `mediaProxyReference` names it, so HyperFrames finds the proxy wherever it finds the
 * original. A recording with no ready proxy plays its original. `path` is where the file is in
 * the version: its references are read from there, as HyperFrames reads them.
 */
export function rewriteVideoProxies(
  html: string,
  path: string,
  files: readonly ArtifactFile[],
  media: ReadonlyMap<string, ArtifactMediaRecord>
): string {
  const held = new Map(files.map((file) => [file.path, file]))
  return new HTMLRewriter()
    .on("video[src], audio[src], source[src]", {
      element(element) {
        const written = decodeHtmlEntities(element.getAttribute("src") ?? "").trim()
        const target = videoFilePath(path, written, (candidate) => held.has(candidate))
        const file = target === undefined ? undefined : held.get(target)
        const proxy = file ? mediaProxyReference(file, media.get(file.file.digest)) : null
        if (!proxy) return

        // Only the query: the path stays as written, which HyperFrames resolves as it did.
        element.setAttribute(
          "src",
          `${written.replace(/[?#].*$/, "")}${proxy.slice(proxy.indexOf("?"))}`
        )
      },
    })
    .transform(html)
}
