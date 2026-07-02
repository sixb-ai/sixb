import type { FileRef } from "@sixb/core"
import { DEFAULT_SIMPLE_FILE_UPLOAD_BYTES } from "@sixb/core/blob-storage"
import { isSixbApiError, type SixbClient } from "./api"
import {
  abortFileUpload,
  completeFileUpload,
  createFileUpload,
  signFileUploadPart,
  uploadFileContent,
  uploadFileRaw,
} from "./generated/sdk.gen"
import { computeStreamingBlobDigest } from "./sha256"

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

export interface UploadFileOptions {
  readonly fileName?: string
  readonly logicalPath?: string
  readonly client?: SixbClient
  readonly fetch?: typeof fetch
  readonly stagedUploadThresholdBytes?: number
  readonly signal?: AbortSignal
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
  const body = {
    file: resolveUploadFile(file, options.fileName),
    ...(options.logicalPath === undefined ? {} : { logicalPath: options.logicalPath }),
  }

  const data = await runUploadStep("server-put", () =>
    uploadFileRaw({ body, client: options.client, ...callOptions(options.signal) })
  )
  return toFileRef(data, "server-put")
}

async function uploadFileStaged(file: File | Blob, options: UploadFileOptions): Promise<FileRef> {
  const digest = await hashFile(file)
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

  let parts: Array<{ partNumber: number; etag: string }> | undefined
  let completed: Omit<FileRef, "digest"> & { readonly digest: string }
  try {
    if (upload.strategy === "server") {
      await runUploadStep("server-put", () =>
        uploadFileContent({
          body: resolveUploadFile(file, options.fileName),
          path: { uploadId: upload.uploadId },
          client: options.client,
          ...callOptions(options.signal),
        })
      )
    } else if (upload.strategy === "direct-put") {
      await putDirectUpload({
        file,
        fetch: options.fetch ?? globalThis.fetch,
        headers: upload.headers,
        method: upload.method,
        url: upload.url,
        signal: options.signal,
      })
    } else {
      parts = await uploadMultipartFile({
        client: options.client,
        fetch: options.fetch ?? globalThis.fetch,
        file,
        partSizeBytes: upload.partSizeBytes,
        uploadId: upload.uploadId,
        signal: options.signal,
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
  let response: Response
  try {
    response = await input.fetch(input.url, {
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

async function uploadMultipartFile(input: {
  readonly client?: SixbClient
  readonly fetch: typeof fetch
  readonly file: File | Blob
  readonly partSizeBytes: number
  readonly uploadId: string
  readonly signal?: AbortSignal
}): Promise<Array<{ partNumber: number; etag: string }>> {
  const parts: Array<{ partNumber: number; etag: string }> = []
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
      response = await input.fetch(signedPart.url, {
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
    if (!etag) {
      throw new SixbFileUploadError(
        `[SixbClient] Multipart file upload part ${partNumber} did not return an ETag.`,
        { stage: "multipart" }
      )
    }

    parts.push({ partNumber, etag })
    partNumber += 1
  }

  return parts
}

async function hashFile(file: File | Blob): Promise<FileRef["digest"]> {
  try {
    return await computeStreamingBlobDigest(file)
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
