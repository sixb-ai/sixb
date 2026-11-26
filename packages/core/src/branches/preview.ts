import { getDomain } from "tldts"
import { RuntimeError } from "../runtime/errors"
import type { BranchRecord } from "../storage/branches"

/**
 * Where people reach a branch production runs: an origin of its own, never production's, so the
 * branch's code never runs where it could call production's API with a viewer's cookies. Under
 * the deployment's preview domain when it has one (`<namespace>.<preview domain>`, which
 * production's server forwards to the branch), else at its sandbox's own URL.
 */
export function branchPreviewOrigin(
  branch: Pick<BranchRecord, "namespace" | "url">,
  previewDomain: string | null
): string | null {
  if (previewDomain) return `https://${branch.namespace}.${previewDomain}`
  return branch.url ? new URL(branch.url).origin : null
}

/**
 * What a request's host is under the preview domain: a branch's namespace for `<namespace>.<preview
 * domain>`, `"other"` for any other host there (the bare domain, nested labels), or null for a
 * host outside it, which is production's. A trailing dot and a port change nothing.
 */
export function previewNamespaceOf(
  host: string | null,
  previewDomain: string | null
): string | "other" | null {
  if (!host || !previewDomain) return null

  const name = host.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "")
  if (name === previewDomain) return "other"

  const suffix = `.${previewDomain}`
  if (!name.endsWith(suffix)) return null

  const label = name.slice(0, -suffix.length)
  return /^[a-z0-9-]+$/.test(label) ? label : "other"
}

const HOSTNAME =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/

/**
 * The site a host belongs to, as a browser decides what is same-site: its registrable domain under
 * the Public Suffix List, its private part included. `app.shop.dev` is on `shop.dev`'s; each of
 * `a.vercel.app` and `b.vercel.app` is a site of its own, because `vercel.app` is on the list.
 */
export function siteOf(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, "")
  return getDomain(host, { allowPrivateDomains: true }) ?? host
}

/**
 * A preview domain production can serve branches under: a host name on a site of its own. A
 * branch's pages on production's site would be same-site with it: the browser would send them
 * production's `SameSite` cookies, and their scripts could set production's CSRF cookie, so a
 * branch could act as whoever opens it. `cookieDomain` is production's when it spans a domain.
 */
export function capturePreviewDomain(value: unknown, cookieDomain: string | undefined): string {
  if (typeof value !== "string" || !HOSTNAME.test(value.toLowerCase())) {
    throw new RuntimeError(
      "[Sixb] source.previewDomain must be a host name, such as `shop-preview.dev`: each branch is served at `<branch>.shop-preview.dev`."
    )
  }

  const domain = value.toLowerCase()
  const cookies = cookieDomain?.toLowerCase().replace(/^\./, "")
  if (cookies) assertPreviewSiteApart(domain, [{ what: "cookieDomain", host: cookies }])
  return domain
}

/**
 * Refuses a preview domain on the same site as one of production's hosts: its API, its app, or
 * the domain its cookies span. Production's server checks its origins when it starts.
 */
export function assertPreviewSiteApart(
  previewDomain: string,
  production: readonly { readonly what: string; readonly host: string }[]
): void {
  const site = siteOf(`branch.${previewDomain}`)
  for (const { what, host } of production) {
    if (siteOf(host) !== site) continue

    throw new RuntimeError(
      `[Sixb] source.previewDomain '${previewDomain}' is on the same site as production's ${what} ('${host}'): both are on '${site}', so a branch's pages would get production's cookies, and could set its CSRF cookie. Serve branches under a domain of their own, such as 'shop-preview.dev'. vercel.app is safe because it is on the Public Suffix List, which makes each of its subdomains a site of its own.`
    )
  }
}
