import {
  ARTIFACT_FRAME_ROUTE_PREFIX,
  FRAME_CDN_ALLOWLIST,
} from "@sixb/core/internal/artifacts/frames"
import {
  type ResolvedSixbApiBrowserPolicy,
  resolveApiBrowserPublicOrigin,
} from "../auth/browser-origin"

/**
 * The policy every frame response carries, 404s included. The frame is sandboxed without
 * `allow-same-origin`, so its page cannot read the app's cookies or call the API as the reader;
 * it loads only its own version's files, under its token, and the CDNs above; only the app's
 * origins may show it.
 *
 * A page reads its queries' rows as the reader, so it posts no form, and opens no window, not
 * even one the reader's click allows: the app opens the web links the reader follows, and its own
 * policy keeps the frame's navigations on the frames' origin. No policy reaches WebRTC: a page's
 * code can still connect to a server it names that way.
 */
export function frameContentSecurityPolicy(input: {
  readonly policy: ResolvedSixbApiBrowserPolicy
  readonly request: Request
  readonly token: string
}): string {
  const origin = resolveApiBrowserPublicOrigin(input.policy, input.request)
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
    `frame-ancestors 'self' ${input.policy.allowedOrigins.join(" ")}`.trim(),
    "sandbox allow-scripts allow-modals",
  ].join("; ")
}
