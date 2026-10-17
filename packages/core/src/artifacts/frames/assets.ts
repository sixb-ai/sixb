import type { ArtifactFrameTarget } from "../../storage/artifacts/types"
import { isArtifactAddress, parseArtifactAddress } from "../address"
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
 * either still renders in standards mode.
 */
export async function injectFrameAssets(html: string): Promise<string> {
  const target = /<head[\s>]/i.test(html) ? "head" : /<html[\s>]/i.test(html) ? "html" : null
  if (!target) {
    const doctype = /^\s*<!doctype[^>]*>/i.exec(html)?.[0] ?? ""
    return `${doctype}${INJECTED}${html.slice(doctype.length)}`
  }
  let injected = false
  return new HTMLRewriter()
    .on(target, {
      element(element) {
        if (injected) return
        injected = true
        element.prepend(INJECTED, { html: true })
      },
    })
    .transform(new Response(html))
    .text()
}

/** Where a frame serves a file another artifact lends it: `__ref/<id>@<version>/<path>`. */
export const FRAME_REFERENCE_PREFIX = `${FRAME_ASSET_PREFIX}ref/`

/** The path, under a frame's base, of a file one of its targets lends it. */
export function frameReferencePath(target: ArtifactFrameTarget): string | null {
  const file = parseArtifactAddress(target.address)?.path
  if (!file) return null
  const path = file.split("/").map(encodeURIComponent).join("/")
  return `${FRAME_REFERENCE_PREFIX}${target.artifactId}@${target.version}/${path}`
}

/**
 * Points each image a deck shows from another artifact (`<img src="artifact:…">`) at the copy its
 * frame serves, marked `data-sixb-ref`. An image its reader cannot see, or that the frame has
 * no target for, loses its source and is marked unavailable: the kit draws it as an empty box.
 */
export async function rewriteFrameReferences(
  html: string,
  targets: readonly ArtifactFrameTarget[]
): Promise<string> {
  return new HTMLRewriter()
    .on("img[src]", {
      element(element) {
        const source = (element.getAttribute("src") ?? "").trim()
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
    .transform(new Response(html))
    .text()
}

/**
 * Sixb's default theme tokens, light and dark, as the app sends them into a frame. The layout
 * check measures a deck in both, since a deck follows the app's mode, and the project's own
 * theme is out of the sandbox's reach.
 */
export const FRAME_DEFAULT_THEMES = {
  light: {
    dark: false,
    tokens: {
      "--background": "#fafafa",
      "--foreground": "#101010",
      "--card": "#ffffff",
      "--card-foreground": "#101010",
      "--muted": "#f4f4f4",
      "--muted-foreground": "#5f5f5f",
      "--primary": "#0a0a0a",
      "--primary-foreground": "#ffffff",
      "--accent": "#f0f0f0",
      "--accent-foreground": "#202020",
      "--border": "#e2e2e2",
    },
  },
  dark: {
    dark: true,
    tokens: {
      "--background": "#0a0a0a",
      "--foreground": "#f4f4f4",
      "--card": "#141414",
      "--card-foreground": "#f4f4f4",
      "--muted": "#1c1c1c",
      "--muted-foreground": "#8a8a8a",
      "--primary": "#f4f4f4",
      "--primary-foreground": "#0a0a0a",
      "--accent": "#1c1c1c",
      "--accent-foreground": "#f4f4f4",
      "--border": "#262626",
      "--chart-1": "#f4f4f4",
      "--chart-2": "#c4c4c4",
      "--chart-3": "#8a8a8a",
      "--chart-4": "#5f5f5f",
      "--chart-5": "#404040",
    },
  },
} as const
