import type { ArtifactFrameTarget } from "../../storage/artifacts/types"
import { isArtifactAddress, parseArtifactAddress } from "../address"
import { decodeHtmlEntities } from "../html"
import type { DocumentHeading } from "../outline"
import type { DocumentPaper } from "../paper"
import { FRAME_ASSET_PREFIX } from "../publish/validate/html"
import type { FrameLayout } from "./entries"
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
 * a kit per layout, and the runtime. The server serves them to the app's frames, and the Agent's
 * layout check serves them to its browser, so both lay a version out the same way.
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
    body: `(${frameRuntime.toString()})()\n`,
    type: "text/javascript; charset=utf-8",
  },
}

/**
 * The kit for the layout and the runtime, which reads the layout from its own tag, and a designed
 * document's paper: its width, height, and margins, top, right, bottom and left, in pixels.
 */
function injected(layout: FrameLayout, base: string, paper?: DocumentPaper): string {
  const sheet = paper
    ? ` data-sixb-paper="${[paper.width, paper.height, paper.margin.top, paper.margin.right, paper.margin.bottom, paper.margin.left].join(" ")}"`
    : ""
  return `<link rel="stylesheet" href="${base}${FRAME_ASSET_PREFIX}${layout}.css"><script src="${base}${FRAME_ASSET_PREFIX}runtime.js" data-sixb-layout="${layout}"${sheet}></script>`
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
 * Points each image an entry shows from another artifact (`<img src="artifact:…">`) at the copy its
 * frame serves, marked `data-sixb-ref`. An image its reader cannot see, or that the frame has
 * no target for, loses its source and is marked unavailable: the kit draws it as an empty box.
 * Addresses are compared as publishing recorded them, with their entities decoded.
 */
export function rewriteFrameReferences(
  html: string,
  targets: readonly ArtifactFrameTarget[],
  entry = "index.html"
): string {
  return new HTMLRewriter()
    .on("img[src]", {
      element(element) {
        const source = decodeHtmlEntities(element.getAttribute("src") ?? "").trim()
        if (!isArtifactAddress(source)) return
        const target = targets.find((candidate) => candidate.address === source)
        const path = target ? frameReferencePath(target, entry) : null
        if (path) {
          element.setAttribute("src", path)
          element.setAttribute("data-sixb-ref", "")
        } else {
          element.removeAttribute("src")
          element.setAttribute("data-sixb-ref", "unavailable")
        }
      },
    })
    .transform(html)
}
