import type { RestClient, RestRequestInit } from "@sixb/connector-rest"
import { MetaApiError, type MetaHttpContext, parseMetaBody } from "./http"
import type {
  MetaResourceOptions,
  MetaUploadResult,
  MetaVideoUploadSource,
} from "./types/publishing"

/** Scope all reads, writes and upload transfers without mutating the shared client. */
export function scopeContext(
  context: MetaHttpContext,
  options?: MetaResourceOptions
): MetaHttpContext {
  if (options?.accessToken === undefined) return context
  nonEmpty(options.accessToken, "accessToken")
  return {
    ...context,
    http: authorize(context.http, `Bearer ${options.accessToken}`),
    uploadHttp: authorize(context.uploadHttp, `OAuth ${options.accessToken}`),
  }
}

function authorize(http: RestClient, token: string): RestClient {
  function init(input?: RestRequestInit): RestRequestInit {
    const headers = new Headers(input?.headers)
    headers.set("authorization", token)
    return { ...input, headers }
  }
  return {
    request: (path, input, options) => http.request(path, init(input), options),
    get: (path, input, options) => http.get(path, init(input), options),
    post: (path, body, input, options) => http.post(path, body, init(input), options),
  }
}

/** A mutation is never automatically replayed, even by a custom retry policy. */
export async function write<T>(
  context: MetaHttpContext,
  path: string,
  body: unknown,
  expected: "id" | "success" | "session" = "id"
): Promise<T> {
  const response = await context.http.post(path, body, { redirect: "error" }, { retryable: false })
  return readWriteResult<T>(response, expected)
}

async function readWriteResult<T>(
  response: Response,
  expected: "id" | "success" | "session"
): Promise<T> {
  const raw = await response.text()
  const body = parseMetaBody(raw)
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {}
  const hasId = (key: string) => typeof record[key] === "string" && record[key].trim().length > 0
  const valid =
    expected === "success"
      ? record.success === true
      : expected === "session"
        ? hasId("video_id") && hasId("upload_url")
        : hasId("id")
  if (!response.ok || record.error !== undefined || record.debug_info !== undefined || !valid) {
    // Includes 2xx failure envelopes and malformed acknowledgements. Never infer publication.
    throw new MetaApiError(response.status, body, response.headers, raw)
  }
  return body as T
}

export async function uploadVideo(
  context: MetaHttpContext,
  uri: string,
  id: string,
  family: "ig-api-upload" | "video-upload",
  source: MetaVideoUploadSource
): Promise<MetaUploadResult> {
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    throw new Error("[SixbMeta] Invalid Meta upload URI for this media.")
  }
  const parts = url.pathname.split("/").filter(Boolean)
  const validPath =
    parts.length === 2
      ? parts[0] === family && parts[1] === id
      : parts.length === 3 &&
        parts[0] === family &&
        /^v\d+\.\d+$/.test(parts[1] ?? "") &&
        parts[2] === id
  if (
    url.protocol !== "https:" ||
    url.hostname !== "rupload.facebook.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !validPath
  ) {
    throw new Error("[SixbMeta] Invalid Meta upload URI for this media.")
  }
  allowedKeys(source, ["file_url", "file", "offset"])
  const headers = new Headers()
  let body: Blob | undefined
  if ("file_url" in source && source.file_url !== undefined) {
    if (source.file !== undefined || source.offset !== undefined) {
      throw new Error("[SixbMeta] Specify file_url or file, not both.")
    }
    mediaUrl(source.file_url, "file_url")
    headers.set("file_url", source.file_url)
  } else {
    if (!(source.file instanceof Blob) || source.file.size === 0) {
      throw new Error("[SixbMeta] file must be a non-empty Blob.")
    }
    const offset = source.offset ?? 0
    integer(offset, "offset", 0)
    if (offset >= source.file.size) throw new Error("[SixbMeta] offset must be below file size.")
    headers.set("offset", String(offset))
    headers.set("file_size", String(source.file.size))
    headers.set("content-type", "application/octet-stream")
    body = source.file.slice(offset)
  }
  const response = await context.uploadHttp.post(
    url.href,
    body,
    { headers, redirect: "error" },
    { retryable: false }
  )
  return readWriteResult<MetaUploadResult>(response, "success")
}

export function nonEmpty(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`[SixbMeta] ${name} must be a non-empty string.`)
  }
}

export function mediaUrl(value: unknown, name: string): void {
  nonEmpty(value, name)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`[SixbMeta] ${name} must be an HTTP(S) URL.`)
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error(`[SixbMeta] ${name} must be an HTTP(S) URL without credentials.`)
  }
}

export function integer(value: unknown, name: string, minimum: number): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`[SixbMeta] ${name} must be an integer >= ${minimum}.`)
  }
}

export function allowedKeys(input: object, keys: readonly string[]): void {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("[SixbMeta] Input must be an object.")
  }
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && !keys.includes(key)) {
      throw new Error(`[SixbMeta] Unsupported field for this media: ${key}.`)
    }
  }
}

export function optionalText(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`[SixbMeta] ${name} must be a string.`)
  }
}

export function textLimit(value: unknown, name: string, maximum: number): void {
  if (value === undefined) return
  if (typeof value !== "string" || Array.from(value).length > maximum) {
    throw new Error(`[SixbMeta] ${name} must be a string of at most ${maximum} characters.`)
  }
}

/** Native JSON for hosted media; multipart for local files. Never stringify a Blob. */
export function mediaBody(input: object): object | FormData {
  const entries = Object.entries(input).filter(([, value]) => value !== undefined)
  if (!entries.some(([, value]) => value instanceof Blob)) return input
  const body = new FormData()
  for (const [key, value] of entries) {
    if (value instanceof Blob) body.set(key, value)
    else body.set(key, typeof value === "object" ? JSON.stringify(value) : String(value))
  }
  return body
}
