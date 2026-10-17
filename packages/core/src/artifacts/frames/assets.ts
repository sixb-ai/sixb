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
