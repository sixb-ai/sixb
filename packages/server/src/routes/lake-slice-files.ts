import type { SixbHostView } from "@sixb/core"
import { LAKE_SLICE_FILES_ROUTE_PREFIX, openLakeSliceFile } from "@sixb/core/internal/lake-slices"
import type { Elysia } from "elysia"
import { parseSingleByteRange, rangeNotSatisfiableResponse } from "../files/content"

interface LakeSliceFileContext {
  readonly request: Request
  readonly set: { status?: number | string }
}

/**
 * Serves production's lake files to a branch that reads them in place: only the files of the
 * slice its token names, with byte ranges, for as long as the token lasts. Public, because the
 * branch holds no session in production: the slice token, sent as a bearer, is the credential.
 * Read-only by construction: there is no other method. Hidden from OpenAPI like download URLs;
 * the DuckLake provider calls it, no client builds it.
 */
export function registerLakeSliceFileRoutes(app: Elysia, host: SixbHostView) {
  const path = `${LAKE_SLICE_FILES_ROUTE_PREFIX}*`
  return app
    .get(path, (context) => lakeSliceFileResponse(host, context), { detail: { hide: true } })
    .head(path, (context) => lakeSliceFileResponse(host, context, { head: true }), {
      detail: { hide: true },
    })
}

async function lakeSliceFileResponse(
  host: SixbHostView,
  { request, set }: LakeSliceFileContext,
  options: { readonly head?: boolean } = {}
): Promise<Response | { readonly error: string }> {
  const authorization = request.headers.get("authorization") ?? ""
  const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : ""
  const path = decodedPath(
    new URL(request.url).pathname.slice(LAKE_SLICE_FILES_ROUTE_PREFIX.length)
  )

  const result =
    path === null ? { kind: "not_found" as const } : await openLakeSliceFile(host, { token, path })
  if (result.kind === "unavailable") {
    set.status = 501
    return { error: result.message }
  }
  if (result.kind === "unauthorized") {
    set.status = 401
    return { error: "[SixbServer] This lake slice token is unknown or expired. Ask for a new one." }
  }
  if (result.kind === "not_found") {
    set.status = 404
    return {
      error:
        "[SixbServer] This lake slice holds no such file. Take a new slice for the branch if production's datasets changed since.",
    }
  }

  const { file } = result
  const headers = new Headers({
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=31536000, immutable",
    "content-length": String(file.sizeBytes),
    "content-type": "application/octet-stream",
    "x-content-type-options": "nosniff",
  })

  const rangeHeader = request.headers.get("range")
  if (rangeHeader) {
    const range = parseSingleByteRange(rangeHeader, file.sizeBytes)
    if (!range) return rangeNotSatisfiableResponse(file.sizeBytes)

    headers.set("content-length", String(range.endInclusive - range.start + 1))
    headers.set("content-range", `bytes ${range.start}-${range.endInclusive}/${file.sizeBytes}`)
    return new Response(options.head ? null : file.read(range), { status: 206, headers })
  }

  return new Response(options.head ? null : file.read(), { headers })
}

/** The file's path in the lake, each segment decoded once; null when one does not decode. */
function decodedPath(encoded: string): string | null {
  try {
    return encoded.split("/").map(decodeURIComponent).join("/")
  } catch {
    return null
  }
}
