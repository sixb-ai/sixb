import {
  ARTIFACT_FRAME_ROUTE_PREFIX,
  FRAME_ASSET_PREFIX,
  FRAME_KIT_CSS,
  frameRuntime,
} from "@sixb/core/internal/artifacts/frames"

/**
 * Hosts a frame may load from besides its own files: CSS and script libraries and web fonts. Each
 * is a public CDN; a frame that uses one contacts it when it opens.
 */
export const FRAME_CDN_ALLOWLIST = [
  "https://cdn.jsdelivr.net",
  "https://cdnjs.cloudflare.com",
  "https://unpkg.com",
  "https://fonts.googleapis.com",
  "https://fonts.gstatic.com",
] as const

export interface FrameOrigins {
  /** The API's origin as browsers reach it, when it differs from the one requests arrive at. */
  readonly publicOrigin?: string
  /** App origins allowed to show a frame. */
  readonly appOrigins: readonly string[]
}

/**
 * The policy every frame response carries, 404s included. The frame is sandboxed without
 * `allow-same-origin`, so its page cannot read the app's cookies or call the API as the reader;
 * it loads only its own version's files, under its token, and the CDNs above; only the app's
 * origins may show it.
 */
export function frameContentSecurityPolicy(input: {
  readonly origins: FrameOrigins
  readonly requestUrl: string
  readonly token: string
}): string {
  const origin = input.origins.publicOrigin ?? new URL(input.requestUrl).origin
  const base = `${origin}${ARTIFACT_FRAME_ROUTE_PREFIX}${input.token}/`
  const cdn = FRAME_CDN_ALLOWLIST.join(" ")
  return [
    "default-src 'none'",
    `script-src ${base} 'unsafe-inline' ${cdn}`,
    `style-src ${base} 'unsafe-inline' ${cdn}`,
    `img-src ${base} data: blob: ${cdn}`,
    `font-src ${base} data: ${cdn}`,
    `media-src ${base} data: blob:`,
    `connect-src ${base}`,
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors 'self' ${input.origins.appOrigins.join(" ")}`.trim(),
    "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals",
  ].join("; ")
}

/** The kit and the runtime, served beside a version's files under `__sixb/`. */
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
