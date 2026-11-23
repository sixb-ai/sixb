import type { FileRef } from "@sixb/core"
import { DEFAULT_SIMPLE_FILE_UPLOAD_BYTES } from "@sixb/core/blob-storage"
import { isSixbApiError, type SixbClient } from "./api"
import { getClientSharedGrantId } from "./client-authority"
import { client as sharedClient } from "./generated/client.gen"
import { formDataBodySerializer } from "./generated/core/bodySerializer.gen"
import {
  abortFileUpload,
  completeFileUpload,
  createFileUpload,
  signFileUploadPart,
  uploadFileContent,
  uploadFileRaw,
} from "./generated/sdk.gen"
import { computeBlobDigestOffThread, computeStreamingBlobDigest } from "./sha256"

export interface ObjectFileContentUrlInput {
  readonly objectTypeId: string
  readonly objectId: string
  /** Property path segments, without the leading `properties` segment. */
  readonly pathSegments: readonly string[]
  readonly fileRef: FileRef
  readonly disposition?: "inline" | "attachment"
  readonly client?: SixbClient
}

/**
 * Build a rendering/download URL that changes with the file's content or metadata.
 *
 * The URL works as a plain `src`/`href`: elements such as `<img>` and `<video>` cannot send the
 * Share selector header, so a shared client names its grant in the query instead. The grant's
 * HttpOnly session cookie remains the credential.
 */
export function objectFileContentUrl(input: ObjectFileContentUrlInput): string {
  if (!input.objectTypeId || !input.objectId || input.pathSegments.length === 0) {
    throw new Error("[SixbClient] File content URLs require an object type, ID, and property path.")
  }
  const client = input.client ?? sharedClient
  const { digest, fileName, mediaType, logicalPath } = input.fileRef
  return client.buildUrl({
    baseUrl: client.getConfig().baseUrl,
    url: "/api/objects/{objectTypeId}/{objectId}/files/content",
    path: { objectTypeId: input.objectTypeId, objectId: input.objectId },
    query: {
      path: `/properties/${input.pathSegments
        .map((segment) => segment.replaceAll("~", "~0").replaceAll("/", "~1"))
        .join("/")}`,
      disposition: input.disposition,
      shareGrant: getClientSharedGrantId(client) ?? undefined,
      // Opaque cache key, not a historical-file selector. Include per-reference metadata.
      // Encode each field so Elysia won't interpret commas in filenames as an array.
      v: [digest, fileName ?? "", mediaType ?? "", logicalPath ?? ""]
        .map(encodeURIComponent)
        .join(":"),
    },
  })
}

/**
 * A file's content URL, or a board preview's, as an `<img>`, a `<video>` or a download link loads
 * it without the client: a shared client names its grant in the query, as `objectFileContentUrl`
 * does, because such a request cannot send the header. The grant's HttpOnly session cookie stays
 * the credential. Only those routes read the grant from the query: any other URL passed here is
 * still refused to a shared link's visitor. Any other client's URL is unchanged.
 */
export function withSharedAccess(url: string, client: SixbClient = sharedClient): string {
  const grantId = getClientSharedGrantId(client)
  if (grantId === null) return url

  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(url)
  const shared = new URL(url, "http://sixb.invalid")
  shared.searchParams.set("shareGrant", grantId)
  return absolute ? shared.toString() : `${shared.pathname}${shared.search}${shared.hash}`
}

export type SixbFileUploadStage =
  | "hash"
  | "create"
  | "server-put"
  | "direct-put"
  | "multipart"
  | "complete"
  | "abort"

export class SixbFileUploadError extends Error {
  readonly stage: SixbFileUploadStage
  readonly status?: number
  readonly aborted: boolean

  constructor(
    message: string,
    options: {
      readonly stage: SixbFileUploadStage
      readonly status?: number
      readonly aborted?: boolean
      readonly cause?: unknown
    }
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = "SixbFileUploadError"
    this.stage = options.stage
    this.status = options.status
    this.aborted = options.aborted ?? false
  }
}

/**
 * How far an upload is. A staged upload first reads the file for its digest (`hash`), then sends
 * it (`upload`); a file under the staged threshold is only sent. In a browser, a file the API
 * receives itself is counted as it is sent, whatever its size. Otherwise, what one request sends
 * is counted once it is sent: fetch reports no progress within a request, so a file sent whole
 * goes from none of it to all of it at once, and one sent in parts, part by part.
 */
export interface FileUploadProgress {
  readonly stage: "hash" | "upload"
  readonly loadedBytes: number
  readonly totalBytes: number
}

export interface UploadFileOptions {
  readonly fileName?: string
  readonly logicalPath?: string
  readonly client?: SixbClient
  readonly fetch?: typeof fetch
  readonly stagedUploadThresholdBytes?: number
  readonly signal?: AbortSignal
  readonly onProgress?: (progress: FileUploadProgress) => void
  /** The file's digest, from {@link fileDigest}: a staged upload then reads it no more. */
  readonly digest?: FileRef["digest"]
}

/**
 * A file's digest, as its upload names it: what tells a file already stored from a new one before
 * sending it. Read in slices, as a staged upload reads it, `onBytes` after each; a large one in a
 * worker, so a page hashing gigabytes never stops answering.
 */
export async function fileDigest(
  file: File | Blob,
  onBytes?: (hashedBytes: number) => void
): Promise<FileRef["digest"]> {
  try {
    return await computeBlobDigestOffThread(file, { ...(onBytes ? { onBytes } : {}) })
  } catch (error) {
    throw toSixbFileUploadError(error, "hash")
  }
}

export interface UploadFileInput extends UploadFileOptions {
  readonly file: File | Blob
}

export async function uploadFile(
  file: File | Blob,
  options: UploadFileOptions = {}
): Promise<FileRef> {
  const thresholdBytes = options.stagedUploadThresholdBytes ?? DEFAULT_SIMPLE_FILE_UPLOAD_BYTES
  if (file.size > thresholdBytes) {
    return uploadFileStaged(file, options)
  }

  return uploadFileSimple(file, options)
}

async function uploadFileSimple(file: File | Blob, options: UploadFileOptions): Promise<FileRef> {
  const progress = (loadedBytes: number) =>
    options.onProgress?.({ stage: "upload", loadedBytes, totalBytes: file.size })
  const body = {
    file: resolveUploadFile(file, options.fileName),
    ...(options.logicalPath === undefined ? {} : { logicalPath: options.logicalPath }),
  }

  // The form the SDK sends, built as it builds it, so XHR sends the same fields.
  const transport = progressTransport(
    options.client ?? sharedClient,
    () => formDataBodySerializer.bodySerializer(body),
    file.size,
    progress
  )

  progress(0)
  const data = await runUploadStep("server-put", () =>
    uploadFileRaw({
      body,
      client: options.client,
      ...callOptions(options.signal),
      ...(transport === undefined ? {} : { fetch: transport }),
    })
  )
  progress(file.size)
  return toFileRef(data, "server-put")
}

async function uploadFileStaged(file: File | Blob, options: UploadFileOptions): Promise<FileRef> {
  const progress = (stage: FileUploadProgress["stage"], loadedBytes: number) =>
    options.onProgress?.({ stage, loadedBytes, totalBytes: file.size })
  const digest =
    options.digest ?? (await hashFile(file, (hashedBytes) => progress("hash", hashedBytes)))
  const uploadBody = {
    ...(resolveUploadFileName(file, options.fileName) === undefined
      ? {}
      : { fileName: resolveUploadFileName(file, options.fileName) }),
    ...(file.type ? { mediaType: file.type } : {}),
    sizeBytes: file.size,
    digest,
    ...(options.logicalPath === undefined ? {} : { logicalPath: options.logicalPath }),
  }

  const upload = await runUploadStep("create", () =>
    createFileUpload({ body: uploadBody, client: options.client, ...callOptions(options.signal) })
  )

  let parts: Array<{ partNumber: number; etag?: string }> | undefined
  let completed: Omit<FileRef, "digest"> & { readonly digest: string }
  try {
    progress("upload", 0)
    if (upload.strategy === "server") {
      const body = resolveUploadFile(file, options.fileName)
      const transport = progressTransport(
        options.client ?? sharedClient,
        () => body,
        file.size,
        (sentBytes) => progress("upload", sentBytes)
      )

      await runUploadStep("server-put", () =>
        uploadFileContent({
          body,
          path: { uploadId: upload.uploadId },
          client: options.client,
          ...callOptions(options.signal),
          ...(transport === undefined ? {} : { fetch: transport }),
        })
      )
      progress("upload", file.size)
    } else if (upload.strategy === "direct-put") {
      await putDirectUpload({
        file,
        fetch: options.fetch ?? globalThis.fetch,
        headers: upload.headers,
        method: upload.method,
        url: upload.url,
        signal: options.signal,
      })
      progress("upload", file.size)
    } else {
      parts = await uploadMultipartFile({
        client: options.client,
        fetch: options.fetch ?? globalThis.fetch,
        file,
        partSizeBytes: upload.partSizeBytes,
        partReceipt: upload.partReceipt ?? "etag",
        uploadId: upload.uploadId,
        signal: options.signal,
        onSent: (sentBytes) => progress("upload", sentBytes),
      })
    }

    completed = await runUploadStep("complete", () =>
      completeFileUpload({
        body: { digest, sizeBytes: file.size, ...(parts === undefined ? {} : { parts }) },
        path: { uploadId: upload.uploadId },
        client: options.client,
        ...callOptions(options.signal),
      })
    )
  } catch (error) {
    // Clean up the staged session even on cancellation: run detached (no signal)
    // so an aborted upload still releases server-side state. Swallow its own
    // failure so the original error is what surfaces.
    await abortFileUpload({
      path: { uploadId: upload.uploadId },
      client: options.client,
      responseStyle: "fields",
      throwOnError: false,
    }).catch(() => undefined)
    throw error
  }

  return toFileRef(completed, "complete")
}

async function putDirectUpload(input: {
  readonly file: File | Blob
  readonly fetch: typeof fetch
  readonly headers: Readonly<Record<string, string>>
  readonly method: "PUT"
  readonly url: string
  readonly signal?: AbortSignal
}): Promise<void> {
  // Browser fetch rejects an arbitrary receiver; invoke it as a standalone function.
  const fetch = input.fetch
  let response: Response
  try {
    response = await fetch(input.url, {
      method: input.method,
      headers: input.headers,
      body: input.file,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
  } catch (error) {
    throw toSixbFileUploadError(error, "direct-put")
  }

  if (!response.ok) {
    throw new SixbFileUploadError(
      `[SixbClient] Direct file upload failed with HTTP ${response.status}.`,
      { stage: "direct-put", status: response.status }
    )
  }
}

/**
 * A fetch for the one request that sends a file to the API, through XHR, which says how much of it
 * is sent as fetch does not. Only in a browser, and only for a client whose transport is the
 * browser's own fetch: one that wraps it, as a shared link's or a native session's does, stamps
 * its credential there, so it keeps sending through it.
 *
 * `body` is what the request carries: the file itself, or the form that holds it. A form is longer
 * than its file by its field headers, so what is sent counts as the same share of `sizeBytes`.
 */
function progressTransport(
  client: SixbClient,
  body: () => Blob | FormData,
  sizeBytes: number,
  onSent: (sentBytes: number) => void
): typeof fetch | undefined {
  if (typeof XMLHttpRequest === "undefined" || client.getConfig().fetch !== undefined) {
    return undefined
  }

  const send = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    new Promise<Response>((resolve, reject) => {
      // The SDK hands over the request it built: its URL, its headers, its credentials and its
      // signal are this one's. Its body is sent as it is rather than read again; a form's own
      // content type names the boundary XHR writes, not the one the request was given.
      const request =
        input instanceof Request && init === undefined ? input : new Request(input, init)
      const content = body()
      const xhr = new XMLHttpRequest()
      xhr.open(request.method, request.url)
      xhr.withCredentials = request.credentials === "include"
      xhr.responseType = "blob"
      for (const [name, value] of request.headers) {
        if (content instanceof FormData && name === "content-type") continue
        xhr.setRequestHeader(name, value)
      }

      xhr.upload.onprogress = (event) => onSent(sentShare(event, sizeBytes))
      xhr.onload = () => resolve(xhrResponse(xhr))
      xhr.onerror = () => reject(new TypeError("[SixbClient] The file upload request failed."))
      xhr.onabort = () => reject(new DOMException("The file upload was aborted.", "AbortError"))

      if (request.signal.aborted) {
        reject(new DOMException("The file upload was aborted.", "AbortError"))
        return
      }
      request.signal.addEventListener("abort", () => xhr.abort(), { once: true })
      xhr.send(content)
    })

  return Object.assign(send, { preconnect: globalThis.fetch.preconnect })
}

/** How much of the file a progress event says is sent, never more than all of it. */
function sentShare(
  event: { readonly loaded: number; readonly total?: number; readonly lengthComputable?: boolean },
  sizeBytes: number
): number {
  if (sizeBytes === 0) return 0

  const total = event.lengthComputable && event.total ? event.total : sizeBytes
  return Math.min(sizeBytes, Math.round((event.loaded / total) * sizeBytes))
}

/** What an XHR answered, as fetch would have: a status that takes no body gets none. */
function xhrResponse(xhr: XMLHttpRequest): Response {
  const headers = new Headers()
  for (const line of xhr
    .getAllResponseHeaders()
    .trim()
    .split(/[\r\n]+/)) {
    const separator = line.indexOf(":")
    if (separator > 0)
      headers.append(line.slice(0, separator).trim(), line.slice(separator + 1).trim())
  }

  const bodiless = xhr.status === 204 || xhr.status === 205 || xhr.status === 304
  return new Response(bodiless ? null : xhr.response, {
    status: xhr.status,
    statusText: xhr.statusText,
    headers,
  })
}

async function uploadMultipartFile(input: {
  readonly client?: SixbClient
  readonly fetch: typeof fetch
  readonly file: File | Blob
  readonly partSizeBytes: number
  readonly partReceipt: "etag" | "none"
  readonly uploadId: string
  readonly signal?: AbortSignal
  /** Called after each part with how many bytes are sent so far. */
  readonly onSent?: (sentBytes: number) => void
}): Promise<Array<{ partNumber: number; etag?: string }>> {
  const fetch = input.fetch
  const parts: Array<{ partNumber: number; etag?: string }> = []
  let partNumber = 1

  for (let offset = 0; offset < input.file.size; offset += input.partSizeBytes) {
    const signedPart = await runUploadStep("multipart", () =>
      signFileUploadPart({
        path: { uploadId: input.uploadId, partNumber: partNumber.toString() },
        client: input.client,
        ...callOptions(input.signal),
      })
    )

    let response: Response
    try {
      response = await fetch(signedPart.url, {
        method: signedPart.method,
        headers: signedPart.headers,
        body: input.file.slice(offset, Math.min(input.file.size, offset + input.partSizeBytes)),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
    } catch (error) {
      throw toSixbFileUploadError(error, "multipart")
    }

    if (!response.ok) {
      throw new SixbFileUploadError(
        `[SixbClient] Multipart file upload part ${partNumber} failed with HTTP ${response.status}.`,
        { stage: "multipart", status: response.status }
      )
    }

    const etag = response.headers.get("etag")
    if (input.partReceipt === "etag" && !etag) {
      throw new SixbFileUploadError(
        `[SixbClient] Multipart file upload part ${partNumber} did not return an ETag.`,
        { stage: "multipart" }
      )
    }

    parts.push(input.partReceipt === "etag" && etag ? { partNumber, etag } : { partNumber })
    input.onSent?.(Math.min(input.file.size, offset + input.partSizeBytes))
    partNumber += 1
  }

  return parts
}

async function hashFile(
  file: File | Blob,
  onBytes: (hashedBytes: number) => void
): Promise<FileRef["digest"]> {
  try {
    return await computeStreamingBlobDigest(file, { onBytes })
  } catch (error) {
    throw toSixbFileUploadError(error, "hash")
  }
}

const callOptions = (signal: AbortSignal | undefined) =>
  ({
    responseStyle: "fields",
    throwOnError: false,
    ...(signal === undefined ? {} : { signal }),
  }) as const

// Runs one SDK step under the `{ data, error }` convention: HTTP failures land in
// `error`, transport failures (including aborts) throw — both map to a typed
// SixbFileUploadError tagged with the stage that failed.
async function runUploadStep<T>(
  stage: SixbFileUploadStage,
  call: () => Promise<{
    readonly data?: T
    readonly error?: unknown
    readonly response?: { readonly status: number }
  }>
): Promise<T> {
  let result: {
    readonly data?: T
    readonly error?: unknown
    readonly response?: { status: number }
  }
  try {
    result = await call()
  } catch (error) {
    throw toSixbFileUploadError(error, stage)
  }

  if (result.error !== undefined || result.data === undefined) {
    throw toSixbFileUploadError(result.error, stage, result.response?.status)
  }
  return result.data
}

function toSixbFileUploadError(
  error: unknown,
  stage: SixbFileUploadStage,
  status?: number
): SixbFileUploadError {
  if (isAbortError(error)) {
    return new SixbFileUploadError("[SixbClient] File upload was aborted.", {
      stage: "abort",
      aborted: true,
      cause: error,
    })
  }

  const detail = uploadErrorDetail(error)
  const message = detail ? `[SixbClient] ${detail}` : "[SixbClient] File upload request failed."
  return new SixbFileUploadError(message, {
    stage,
    status: status ?? (isSixbApiError(error) ? error.status : undefined),
    cause: error,
  })
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  )
}

function uploadErrorDetail(error: unknown): string | undefined {
  const body = isSixbApiError(error) ? error.body : error

  if (typeof body === "string") {
    return body.trim() || undefined
  }

  if (body && typeof body === "object" && "error" in body) {
    const message = (body as { readonly error?: unknown }).error
    return typeof message === "string" && message.trim() ? message : undefined
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message
  }

  return undefined
}

function resolveUploadFile(file: File | Blob, fileName: string | undefined): File | Blob {
  if (fileName === undefined) {
    return file
  }

  if (typeof File === "undefined") {
    return file
  }

  return new File([file], fileName, { type: file.type || undefined })
}

function resolveUploadFileName(
  file: File | Blob,
  fileName: string | undefined
): string | undefined {
  if (fileName !== undefined) {
    return fileName
  }

  return typeof File !== "undefined" && file instanceof File && file.name ? file.name : undefined
}

function toFileRef(
  value: Omit<FileRef, "digest"> & { readonly digest: string },
  stage: SixbFileUploadStage
): FileRef {
  if (!value.digest.startsWith("sha256:")) {
    throw new SixbFileUploadError(
      "[SixbClient] File upload response did not include a sha256 digest.",
      { stage }
    )
  }

  return {
    ...value,
    digest: value.digest as FileRef["digest"],
  }
}
