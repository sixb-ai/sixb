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

/** The branch namespace a request's host names under the preview domain, or null. */
export function previewNamespaceOf(
  host: string | null,
  previewDomain: string | null
): string | null {
  if (!host || !previewDomain) return null

  const name = host.toLowerCase().replace(/:\d+$/, "")
  const suffix = `.${previewDomain}`
  if (!name.endsWith(suffix)) return null

  const label = name.slice(0, -suffix.length)
  return /^[a-z0-9-]+$/.test(label) ? label : null
}

const HOSTNAME =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/

/**
 * A preview domain production can serve branches under: a host name of its own, which
 * production's `cookieDomain` does not cover, or production's cookies would reach every branch.
 */
export function capturePreviewDomain(value: unknown, cookieDomain: string | undefined): string {
  if (typeof value !== "string" || !HOSTNAME.test(value.toLowerCase())) {
    throw new RuntimeError(
      "[Sixb] source.previewDomain must be a host name, such as `preview.shop.dev`: each branch is served at `<branch>.preview.shop.dev`."
    )
  }

  const domain = value.toLowerCase()
  const cookies = cookieDomain?.toLowerCase().replace(/^\./, "")
  if (cookies && (domain === cookies || domain.endsWith(`.${cookies}`))) {
    throw new RuntimeError(
      `[Sixb] source.previewDomain '${domain}' is inside production's cookieDomain '${cookieDomain}': production's cookies would reach every branch. Serve branches under a domain of their own, as Vercel does with vercel.app.`
    )
  }
  return domain
}
