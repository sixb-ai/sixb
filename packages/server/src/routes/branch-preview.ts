import type { SixbHostView } from "@sixb/core"
import { BRANCH_KEY_HEADER, previewNamespaceOf } from "@sixb/core/internal/branches"
import { forwardRequest } from "@sixb/core/internal/http"

/**
 * A request to a branch's preview host (`<namespace>.<preview domain>`), forwarded whole to the
 * branch's runtime: it is the branch's, never production's, so nothing of production's handles
 * it. Null for any other host. A branch that is not running answers 404.
 */
export function forwardToPreview(host: SixbHostView, request: Request): Promise<Response> | null {
  const previewDomain = host.source?.previewDomain ?? null
  const namespace = previewNamespaceOf(request.headers.get("host"), previewDomain)
  if (!namespace) return null

  return (async () => {
    const branches = await host.storage.hostedBranches?.list({ projectId: host.id })
    const branch = branches?.find((candidate) => candidate.namespace === namespace)
    if (!branch?.url || branch.state !== "ready") {
      return new Response("No branch runs here.", { status: 404 })
    }

    const url = new URL(request.url)
    return forwardRequest(
      request,
      `${branch.url.replace(/\/+$/, "")}${url.pathname}${url.search}`,
      {
        // Only production holds the key: a request that names it is not production's.
        requestHeaders: (name) => name !== BRANCH_KEY_HEADER,
      }
    ).catch(() => new Response("The branch did not answer.", { status: 502 }))
  })()
}
