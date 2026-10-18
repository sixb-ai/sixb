import type { SixbHostView } from "@sixb/core"
import { parseArtifactAddress } from "@sixb/core/artifacts"
import {
  ARTIFACT_FRAME_ROUTE_PREFIX,
  FRAME_ASSETS,
  FRAME_REFERENCE_PREFIX,
  injectFrameAssets,
  resolveArtifactFrame,
  rewriteFrameReferences,
} from "@sixb/core/internal/artifacts/frames"
import { openFileRef } from "@sixb/core/internal/blob-storage"
import type { Elysia } from "elysia"
import { frameContentSecurityPolicy } from "../artifacts/frame"
import type { ResolvedSixbApiBrowserPolicy } from "../auth/browser-origin"
import { createFileContentResponse } from "../files/content"

interface FrameContext {
  readonly params: { readonly token: string; readonly "*": string }
  readonly request: Request
}

/**
 * Serves a deck's files to its sandboxed frame, under the token a frame link carries: the token
 * is the credential, so the route is public. The entry gets the kit and the runtime, and the kit
 * and runtime are served beside the files. Hidden from OpenAPI: clients receive frame links, they
 * never build them.
 */
export function registerArtifactFrameRoutes(
  app: Elysia,
  host: SixbHostView,
  policy: ResolvedSixbApiBrowserPolicy
) {
  const path = `${ARTIFACT_FRAME_ROUTE_PREFIX}:token/*`
  return app
    .get(path, (context) => frameResponse(host, policy, context), { detail: { hide: true } })
    .head(path, (context) => frameResponse(host, policy, context, { head: true }), {
      detail: { hide: true },
    })
}

async function frameResponse(
  host: SixbHostView,
  policy: ResolvedSixbApiBrowserPolicy,
  { params, request }: FrameContext,
  options: { readonly head?: boolean } = {}
): Promise<Response> {
  const headers = new Headers({
    "content-security-policy": frameContentSecurityPolicy({ policy, request, token: params.token }),
    // The frame's origin is opaque, so its module scripts and fonts arrive with `Origin: null`.
    // Nothing here depends on cookies: the token is the credential.
    "access-control-allow-origin": "*",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  })
  const notFound = () => {
    headers.set("content-type", "text/plain; charset=utf-8")
    headers.set("cache-control", "no-store")
    return new Response(options.head ? null : "Not found", { status: 404, headers })
  }

  // A frame link opens only in a frame. Opened as a page on the API's origin, its sandbox would
  // still let it show dialogs and open windows that escape the sandbox, under the API's address.
  if (request.headers.get("sec-fetch-dest") === "document") return notFound()

  const storage = host.storage.artifacts
  if (!storage) return notFound()
  // An unknown or expired token, a deleted version, and one that is no deck all answer one 404.
  const frame = await resolveArtifactFrame({
    projectId: host.id,
    storage,
    token: params.token,
  })
  if (!frame) return notFound()
  let version = frame.version

  let path = decodePath(params["*"])
  const asset = path === null ? undefined : FRAME_ASSETS[path]
  if (asset) {
    headers.set("content-type", asset.type)
    headers.set("cache-control", "private, max-age=3600")
    return new Response(options.head ? null : asset.body, { headers })
  }
  let lent = false
  if (path?.startsWith(FRAME_REFERENCE_PREFIX)) {
    // A file another artifact lends the deck: only one its frame was issued with, at that version.
    const match = /^([^/@]+)@(\d+)\/(.+)$/.exec(path.slice(FRAME_REFERENCE_PREFIX.length))
    const target = frame.targets.find(
      (candidate) =>
        candidate.artifactId === match?.[1] &&
        candidate.version === Number(match?.[2]) &&
        parseArtifactAddress(candidate.address)?.path === match?.[3]
    )
    const lender = target
      ? await storage.getVersion({
          projectId: host.id,
          artifactId: target.artifactId,
          version: target.version,
        })
      : null
    if (!lender || !match) return notFound()
    version = lender
    path = match[3] ?? null
    lent = true
  }
  const file = version.files.find((candidate) => candidate.path === path)
  if (!file) return notFound()

  if (!lent && file.path === version.entry) {
    const opened = await openFileRef(host.blobStorage, file.file)
    if (!opened) return notFound()
    headers.set("content-type", "text/html; charset=utf-8")
    headers.set("cache-control", "private, no-cache")
    if (options.head) return new Response(null, { headers })
    const text = await new Response(opened.body).text()
    return new Response(injectFrameAssets(rewriteFrameReferences(text, frame.targets)), { headers })
  }

  const response = await createFileContentResponse({
    blobStorage: host.blobStorage,
    fileRef: file.file,
    disposition: "inline",
    head: options.head,
    request,
  })
  if (!response) return notFound()
  // A frame loads its files as the page's parts: inline, under the frame's own policy.
  for (const [name, value] of headers) response.headers.set(name, value)
  response.headers.set("content-disposition", "inline")
  return response
}

function decodePath(raw: string | undefined): string | null {
  try {
    return decodeURIComponent(raw ?? "")
  } catch {
    return null
  }
}
