import type { ArtifactFrameTarget } from "../../storage/artifacts/types"
import { isArtifactAddress, parseArtifactAddress } from "../address"
import { decodeHtmlEntities } from "../html"
import { FRAME_ASSET_PREFIX } from "../publish/validate/slides"
import { FRAME_KIT_CSS } from "./kit"
import { frameRuntime } from "./runtime"

/**
 * The files a frame gets besides the version's own, under `__sixb/`, which a version may not use.
 * The server serves them to the app's frames, and the Agent's layout check serves them to its
 * browser, so both lay a deck out the same way.
 */
export const FRAME_ASSETS: Readonly<
  Record<string, { readonly body: string; readonly type: string }>
> = {
  [`${FRAME_ASSET_PREFIX}kit.css`]: { body: FRAME_KIT_CSS, type: "text/css; charset=utf-8" },
  [`${FRAME_ASSET_PREFIX}runtime.js`]: {
    body: `(${frameRuntime.toString()})()\n`,
    type: "text/javascript; charset=utf-8",
  },
}

const INJECTED = `<link rel="stylesheet" href="${FRAME_ASSET_PREFIX}kit.css"><script src="${FRAME_ASSET_PREFIX}runtime.js"></script>`

/**
 * A deck's entry with the kit and the runtime first in its `<head>`, before anything of its own,
 * so the deck's styles and scripts build on them. Exactly once, whatever the markup: in `<head>`
 * when the page has one, else first in `<html>`, else right after the doctype, so a page without
 * either still renders in standards mode. Each element is looked for by parsing, not by matching
 * text, so a `<head>` inside a comment or a script's string is not one.
 */
export function injectFrameAssets(html: string): string {
  for (const selector of ["head", "html"]) {
    let injected = false
    const rewritten = new HTMLRewriter()
      .on(selector, {
        element(element) {
          if (injected) return
          injected = true
          element.prepend(INJECTED, { html: true })
        },
      })
      .transform(html)
    if (injected) return rewritten
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)?.[0] ?? ""
  return `${doctype}${INJECTED}${html.slice(doctype.length)}`
}

/** Where a frame serves a file another artifact lends it: `__sixb/ref/<id>@<version>/<path>`. */
export const FRAME_REFERENCE_PREFIX = `${FRAME_ASSET_PREFIX}ref/`

/** The path, under a frame's base, of a file one of its targets lends it. */
function frameReferencePath(target: ArtifactFrameTarget): string | null {
  const file = parseArtifactAddress(target.address)?.path
  if (!file) return null
  const path = file.split("/").map(encodeURIComponent).join("/")
  return `${FRAME_REFERENCE_PREFIX}${target.artifactId}@${target.version}/${path}`
}

/**
 * Points each image a deck shows from another artifact (`<img src="artifact:…">`) at the copy its
 * frame serves, marked `data-sixb-ref`. An image its reader cannot see, or that the frame has
 * no target for, loses its source and is marked unavailable: the kit draws it as an empty box.
 * Addresses are compared as publishing recorded them, with their entities decoded.
 */
export function rewriteFrameReferences(
  html: string,
  targets: readonly ArtifactFrameTarget[]
): string {
  return new HTMLRewriter()
    .on("img[src]", {
      element(element) {
        const source = decodeHtmlEntities(element.getAttribute("src") ?? "").trim()
        if (!isArtifactAddress(source)) return
        const target = targets.find((candidate) => candidate.address === source)
        const path = target ? frameReferencePath(target) : null
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
