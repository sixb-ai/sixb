import { ARTIFACT_FRAME_ROUTE_PREFIX } from "@sixb/core/internal/artifacts/frames"

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
