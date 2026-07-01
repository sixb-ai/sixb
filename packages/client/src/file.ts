import type { FileRef } from "@sixb/core"
import { DEFAULT_SIMPLE_FILE_UPLOAD_BYTES } from "@sixb/core/blob-storage"
import type { SixbClient } from "./api"
import {
  abortFileUpload,
  completeFileUpload,
  createFileUpload,
  uploadFileContent,
  uploadFileRaw,
} from "./generated/sdk.gen"
import { computeStreamingBlobDigest } from "./sha256"

export type SixbFileUploadStage =
  | "hash"
  | "create"
  | "server-put"
  | "direct-put"
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
    } else {
      await putDirectUpload({
        file,
        fetch: options.fetch ?? globalThis.fetch,
        headers: upload.headers,
        method: upload.method,
        url: upload.url,
        signal: options.signal,
      })
    }

    completed = await runUploadStep("complete", () =>
      completeFileUpload({
        body: { digest, sizeBytes: file.size },
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

  const message =
    error && typeof error === "object" && "error" in error
      ? `[SixbClient] ${String((error as { error: unknown }).error)}`
      : "[SixbClient] File upload request failed."
  return new SixbFileUploadError(message, { stage, status, cause: error })
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  )
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
