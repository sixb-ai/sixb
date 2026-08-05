import type { RestClient } from "@sixb/connector-rest"
import { GoogleApiError } from "./errors"
import type { QueryParams } from "./types/common"
import type { DriveFileContent } from "./types/drive"
import {
  buildMultipartBody,
  chunkBody,
  createBoundary,
  isBufferedBody,
  MULTIPART_LIMIT_BYTES,
  persistedOffset,
  RESUMABLE_CHUNK_BYTES,
  RESUME_INCOMPLETE,
  toUint8Array,
  uploadSize,
} from "./upload"

/**
 * The Google API surfaces this connector exposes. Adding a surface = add its
 * name here, a base URL in `google.ts`, its typed resources, and one wiring
 * line in `client.ts` — the auth and HTTP core below never change.
 */
export type GoogleSurface = "drive" | "calendar" | "gmail"

export interface GoogleHttpClients {
  /** JSON API clients, keyed by surface. */
  readonly api: Record<GoogleSurface, RestClient>
  /** Upload-host clients for surfaces that support media upload (drive only). */
  readonly upload: Partial<Record<GoogleSurface, RestClient>>
}

/** Every HTTP verb the Google REST surfaces use. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

export interface GoogleRequestOptions {
  readonly query?: QueryParams
  readonly body?: unknown
}

export interface GoogleUploadOptions {
  readonly query?: QueryParams
  /** JSON metadata body — sent as-is for metadata-only writes. */
  readonly metadata?: unknown
  /** Media bytes; their size/shape selects the upload type (see `upload.ts`). */
  readonly content?: DriveFileContent
}

export interface GoogleHttp {
  /** JSON request against a surface; throws `GoogleApiError` on non-2xx. */
  json<T>(
    surface: GoogleSurface,
    method: HttpMethod,
    path: string,
    options?: GoogleRequestOptions
  ): Promise<T>
  /** Raw bytes (e.g. Drive `files.export`); throws `GoogleApiError` on non-2xx. */
  media(
    surface: GoogleSurface,
    path: string,
    options?: { query?: QueryParams }
  ): Promise<Uint8Array>
  /**
   * Write with optional media bytes. No `content` → plain JSON request on the
   * API host. Small buffered content → one `multipart/related` request. Larger
   * or streamed content → a resumable session on the upload host: known sizes
   * are chunked (`Content-Range`, 308-aware); unknown-length streams go as a
   * single streaming PUT.
   */
  upload<T>(
    surface: GoogleSurface,
    method: "POST" | "PATCH",
    path: string,
    options?: GoogleUploadOptions
  ): Promise<T>
}

export function createGoogleHttp(clients: GoogleHttpClients): GoogleHttp {
  const json = async <T>(
    surface: GoogleSurface,
    method: HttpMethod,
    path: string,
    options?: GoogleRequestOptions
  ): Promise<T> => {
    const client = clients.api[surface]
    const url = withQuery(path, options?.query)
    // `post` serializes a JSON body and sets content-type under any verb;
    // `request` covers the bodiless verbs (GET/DELETE) without one.
    const response =
      method === "GET"
        ? await client.get(url)
        : method === "DELETE"
          ? await client.request(url, { method: "DELETE" })
          : await client.post(url, options?.body, { method })
    return readJson<T>(response)
  }

  return {
    json,

    async media(
      surface: GoogleSurface,
      path: string,
      options?: { query?: QueryParams }
    ): Promise<Uint8Array> {
      const response = await clients.api[surface].get(withQuery(path, options?.query))
      if (!response.ok) {
        throw new GoogleApiError(response.status, await readErrorBody(response))
      }
      return new Uint8Array(await response.arrayBuffer())
    },

    upload<T>(
      surface: GoogleSurface,
      method: "POST" | "PATCH",
      path: string,
      options?: GoogleUploadOptions
    ): Promise<T> {
      if (!options?.content) {
        // Metadata-only writes use the plain JSON endpoint.
        return json<T>(surface, method, path, { query: options?.query, body: options?.metadata })
      }

      const client = clients.upload[surface]
      if (!client) {
        throw new Error(`[SixbGoogle] Surface "${surface}" has no upload endpoint.`)
      }

      const { content } = options
      const size = uploadSize(content.body, content.sizeBytes)

      if (size === 0) {
        // Zero-byte uploads complete as one empty multipart request — there is
        // nothing to resume, so a resumable session would be pure overhead.
        return multipartUpload<T>(client, method, path, options, new Uint8Array(0))
      }

      if (isBufferedBody(content.body) && size !== undefined && size <= MULTIPART_LIMIT_BYTES) {
        return multipartUpload<T>(client, method, path, options, content.body)
      }

      return resumableUpload<T>(client, method, path, options, content, size)
    },
  }
}

async function multipartUpload<T>(
  client: RestClient,
  method: "POST" | "PATCH",
  path: string,
  options: GoogleUploadOptions,
  body: Uint8Array | ArrayBuffer | Blob
): Promise<T> {
  const boundary = createBoundary()
  const bytes = buildMultipartBody(
    options.metadata,
    options.content?.mimeType ?? "application/octet-stream",
    await toUint8Array(body),
    boundary
  )

  const response = await client.post(
    withQuery(path, { ...options.query, uploadType: "multipart" }),
    bytes,
    { method, headers: { "content-type": `multipart/related; boundary=${boundary}` } }
  )
  return readJson<T>(response)
}

async function resumableUpload<T>(
  client: RestClient,
  method: "POST" | "PATCH",
  path: string,
  options: GoogleUploadOptions,
  content: DriveFileContent,
  size: number | undefined
): Promise<T> {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=UTF-8",
  }
  if (content.mimeType) {
    headers["x-upload-content-type"] = content.mimeType
  }
  if (size !== undefined) {
    headers["x-upload-content-length"] = String(size)
  }

  const initiation = await client.post(
    withQuery(path, { ...options.query, uploadType: "resumable" }),
    options.metadata === undefined ? undefined : JSON.stringify(options.metadata),
    { method, headers }
  )
  if (!initiation.ok) {
    throw new GoogleApiError(initiation.status, await readErrorBody(initiation))
  }

  const sessionUri = initiation.headers.get("location")
  if (!sessionUri) {
    throw new Error("[SixbGoogle] Resumable upload initiation returned no session URI.")
  }

  // Unknown-length stream: one streaming PUT; Drive completes at stream end.
  if (size === undefined) {
    const body = content.body
    if (body instanceof ReadableStream) {
      // fetch requires `duplex: "half"` for stream bodies (undici/browsers).
      const init = {
        method: "PUT",
        headers: contentHeaders(content.mimeType),
        body,
        duplex: "half",
      } as unknown as RequestInit
      return readJson<T>(await client.request(sessionUri, init))
    }
    throw new Error("[SixbGoogle] Buffered upload bodies always have a known size.")
  }

  // Known size: chunked PUTs with Content-Range. Each chunk stays in memory
  // until the server confirms it, so a partially persisted chunk (308 + Range
  // short of the chunk end) is re-sent from where the server left off.
  const mimeHeaders = contentHeaders(content.mimeType)
  let offset = 0
  for await (const chunk of chunkBody(content.body, RESUMABLE_CHUNK_BYTES)) {
    let sent = 0
    let stalled = 0
    while (sent < chunk.length) {
      const part = chunk.subarray(sent)
      const response = await client.request(sessionUri, {
        method: "PUT",
        headers: {
          ...mimeHeaders,
          // Content-Length is computed by the fetch runtime from the body.
          "content-range": `bytes ${offset + sent}-${offset + sent + part.length - 1}/${size}`,
        },
        // ArrayBufferLike-backed views are fine at runtime; BodyInit wants ArrayBuffer.
        body: part as Uint8Array<ArrayBuffer>,
      })

      if (response.status === RESUME_INCOMPLETE) {
        // The Range header says what the server persisted; without it, assume
        // nothing was persisted and re-send the whole chunk part. A server that
        // keeps answering 308 without acknowledging new bytes is wedged — fail
        // instead of hot-looping the same PUT forever.
        const persisted = persistedOffset(response.headers.get("range"))
        const next = persisted === null ? sent : Math.max(persisted - offset, sent)
        if (next <= sent) {
          stalled += 1
          if (stalled >= MAX_STALLED_ATTEMPTS) {
            throw new Error(
              `[SixbGoogle] Resumable upload stalled: the server acknowledged no new bytes after ${MAX_STALLED_ATTEMPTS} attempts.`
            )
          }
        } else {
          stalled = 0
        }
        sent = next
        continue
      }

      return readJson<T>(response)
    }
    offset += chunk.length
  }

  throw new Error(
    "[SixbGoogle] Resumable upload ended before the declared sizeBytes were uploaded. " +
      "Pass the exact byte count (e.g. from BlobStorage.stat) or omit sizeBytes for unknown lengths."
  )
}

/** Consecutive 308s acknowledging no new bytes before giving up. */
const MAX_STALLED_ATTEMPTS = 3

function contentHeaders(mimeType: string | undefined): Record<string, string> {
  return mimeType ? { "content-type": mimeType } : {}
}

export function withQuery(path: string, query?: QueryParams): string {
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path
  if (!query) {
    return normalizedPath
  }

  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        params.append(key, String(item))
      }
    } else if (value !== undefined) {
      params.append(key, String(value))
    }
  }

  const queryString = params.toString()
  return queryString ? `${normalizedPath}?${queryString}` : normalizedPath
}

/** Encode a required path segment, rejecting empty values early. */
export function pathSegment(value: string, field: string): string {
  if (!value.trim()) {
    throw new Error(`[SixbGoogle] ${field} must not be empty.`)
  }
  return encodeURIComponent(value)
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await readBody(response)
  if (!response.ok) {
    throw new GoogleApiError(response.status, body)
  }
  return body as T
}

async function readErrorBody(response: Response): Promise<unknown> {
  return readBody(response)
}

async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return undefined
  }
  const text = await response.text()
  if (!text) {
    return undefined
  }
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
