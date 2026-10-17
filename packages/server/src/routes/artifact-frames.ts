import type { SixbHostView } from "@sixb/core"
import {
  ARTIFACT_FRAME_ROUTE_PREFIX,
  FRAME_ASSETS,
  injectFrameAssets,
  resolveArtifactFrame,
} from "@sixb/core/internal/artifacts/frames"
import type { Elysia } from "elysia"
import { type FrameOrigins, frameContentSecurityPolicy } from "../artifacts/frame"
import { createFileContentResponse } from "../files/content"

interface FrameContext {
  readonly params: { readonly token: string; readonly "*": string }
  readonly request: Request
}

/**
 * Serves a version's files to its sandboxed frame, under the token a frame link carries: the
 * token is the credential, so the route is public. The entry gets the kit and the runtime, and
 * the kit and runtime are served beside the files. Hidden from OpenAPI: clients receive frame
 * links, they never build them.
 */
export function registerArtifactFrameRoutes(
  app: Elysia,
  host: SixbHostView,
  origins: FrameOrigins
) {
  const path = `${ARTIFACT_FRAME_ROUTE_PREFIX}:token/*`
  return app
    .get(path, (context) => frameResponse(host, origins, context), { detail: { hide: true } })
    .head(path, (context) => frameResponse(host, origins, context, { head: true }), {
      detail: { hide: true },
    })
}

async function frameResponse(
  host: SixbHostView,
  origins: FrameOrigins,
  { params, request }: FrameContext,
  options: { readonly head?: boolean } = {}
): Promise<Response> {
  const headers = new Headers({
    "content-security-policy": frameContentSecurityPolicy({
      origins,
      requestUrl: request.url,
      token: params.token,
    }),
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

  const storage = host.storage.artifacts
  if (!storage) return notFound()
  // An unknown or expired token and a deleted version all answer the same 404.
  const version = await resolveArtifactFrame({
    projectId: host.id,
    storage,
    token: params.token,
  })
  if (!version) return notFound()

  const path = decodePath(params["*"])
  const asset = path === null ? undefined : FRAME_ASSETS[path]
  if (asset) {
    headers.set("content-type", asset.type)
    headers.set("cache-control", "private, max-age=3600")
    return new Response(options.head ? null : asset.body, { headers })
  }
  const file = version.files.find((candidate) => candidate.path === path)
  if (!file) return notFound()

  if (file.path === version.entry) {
    const text = await new Response(await host.blobStorage.open(file.file.blobId)).text()
    const html = await injectFrameAssets(text)
    headers.set("content-type", "text/html; charset=utf-8")
    headers.set("cache-control", "private, no-cache")
    return new Response(options.head ? null : html, { headers })
  }

  const response = await createFileContentResponse({
    blobStorage: host.blobStorage,
    fileRef: file.file,
    disposition: "inline",
    head: options.head,
    rangeHeader: request.headers.get("range"),
    ifNoneMatchHeader: request.headers.get("if-none-match"),
    ifRangeHeader: request.headers.get("if-range"),
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
