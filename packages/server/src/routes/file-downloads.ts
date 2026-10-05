import type { SixbHostView } from "@sixb/core"
import { FILE_DOWNLOAD_ROUTE_PREFIX, resolveFileDownload } from "@sixb/core/internal/blob-storage"
import type { Elysia } from "elysia"
import { createFileContentResponse } from "../files/content"

interface FileDownloadContext {
  readonly params: { readonly token: string }
  readonly request: Request
  readonly set: { status?: number | string }
}

/**
 * Serves the URLs `blobs.createDownloadUrl()` issues. Public, because their readers — social
 * networks fetching media to publish — cannot hold a session: the token is the credential.
 * Hidden from OpenAPI like webhooks; clients receive these URLs, they never build them.
 */
export function registerFileDownloadRoutes(app: Elysia, host: SixbHostView) {
  const path = `${FILE_DOWNLOAD_ROUTE_PREFIX}:token`
  return app
    .get(path, (context) => fileDownloadResponse(host, context), { detail: { hide: true } })
    .head(path, (context) => fileDownloadResponse(host, context, { head: true }), {
      detail: { hide: true },
    })
}

async function fileDownloadResponse(
  host: SixbHostView,
  { params, request, set }: FileDownloadContext,
  options: { readonly head?: boolean } = {}
): Promise<Response | { readonly error: string }> {
  // An unknown, expired, or revoked token and a deleted blob all answer the same 404.
  const fileRef = await resolveFileDownload(host, params.token)
  const response =
    fileRef &&
    (await createFileContentResponse({
      blobStorage: host.blobStorage,
      fileRef,
      head: options.head,
      rangeHeader: request.headers.get("range"),
      ifNoneMatchHeader: request.headers.get("if-none-match"),
      ifRangeHeader: request.headers.get("if-range"),
    }))
  if (!response) {
    set.status = 404
    return { error: "File not found" }
  }
  return response
}
