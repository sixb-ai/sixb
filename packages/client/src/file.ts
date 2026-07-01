import type { FileRef } from "@sixb/core"
import type { SixbClient } from "./api"
import {
  abortFileUpload,
  completeFileUpload,
  createFileUpload,
  signFileUploadPart,
  uploadFileContent,
  uploadFileRaw,
} from "./generated/sdk.gen"

export const DEFAULT_STAGED_FILE_UPLOAD_BYTES = 25 * 1024 * 1024

export interface UploadFileOptions {
  readonly fileName?: string
  readonly logicalPath?: string
  readonly client?: SixbClient
  readonly fetch?: typeof fetch
  readonly stagedUploadThresholdBytes?: number
}

export interface UploadFileInput extends UploadFileOptions {
  readonly file: File | Blob
}

export async function uploadFile(
  file: File | Blob,
  options: UploadFileOptions = {}
): Promise<FileRef> {
  const thresholdBytes = options.stagedUploadThresholdBytes ?? DEFAULT_STAGED_FILE_UPLOAD_BYTES
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

  const { data } = await uploadFileRaw({
    body,
    client: options.client,
    throwOnError: true,
  })

  return toFileRef(data)
}

async function uploadFileStaged(file: File | Blob, options: UploadFileOptions): Promise<FileRef> {
  const digest = await sha256Blob(file)
  const uploadBody = {
    ...(resolveUploadFileName(file, options.fileName) === undefined
      ? {}
      : { fileName: resolveUploadFileName(file, options.fileName) }),
    ...(file.type ? { mediaType: file.type } : {}),
    sizeBytes: file.size,
    digest,
    ...(options.logicalPath === undefined ? {} : { logicalPath: options.logicalPath }),
  }
  const { data: upload } = await createFileUpload({
    body: uploadBody,
    client: options.client,
    throwOnError: true,
  })

  try {
    if (upload.strategy === "server") {
      await uploadFileContent({
        body: resolveUploadFile(file, options.fileName),
        path: { uploadId: upload.uploadId },
        client: options.client,
        throwOnError: true,
      })
    } else if (upload.strategy === "direct-put") {
      await putDirectUpload({
        file,
        fetch: options.fetch ?? globalThis.fetch,
        headers: upload.headers,
        method: upload.method,
        url: upload.url,
      })
    } else {
      const parts = await uploadMultipartFile({
        client: options.client,
        fetch: options.fetch ?? globalThis.fetch,
        file,
        partSizeBytes: upload.partSizeBytes,
        uploadId: upload.uploadId,
      })
      const { data } = await completeFileUpload({
        body: { digest, sizeBytes: file.size, parts },
        path: { uploadId: upload.uploadId },
        client: options.client,
        throwOnError: true,
      })
      return toFileRef(data)
    }

    const { data } = await completeFileUpload({
      body: { digest, sizeBytes: file.size },
      path: { uploadId: upload.uploadId },
      client: options.client,
      throwOnError: true,
    })
    return toFileRef(data)
  } catch (error) {
    await abortFileUpload({
      path: { uploadId: upload.uploadId },
      client: options.client,
      throwOnError: true,
    }).catch(() => undefined)
    throw error
  }
}

async function putDirectUpload(input: {
  readonly file: File | Blob
  readonly fetch: typeof fetch
  readonly headers: Readonly<Record<string, string>>
  readonly method: "PUT"
  readonly url: string
}): Promise<void> {
  const response = await input.fetch(input.url, {
    method: input.method,
    headers: input.headers,
    body: input.file,
  })

  if (!response.ok) {
    throw new Error(`[SixbClient] Direct file upload failed with HTTP ${response.status}.`)
  }
}

async function uploadMultipartFile(input: {
  readonly client?: SixbClient
  readonly fetch: typeof fetch
  readonly file: File | Blob
  readonly partSizeBytes: number
  readonly uploadId: string
}): Promise<Array<{ partNumber: number; etag: string }>> {
  const parts: Array<{ partNumber: number; etag: string }> = []
  let partNumber = 1

  for (let offset = 0; offset < input.file.size; offset += input.partSizeBytes) {
    const { data: signedPart } = await signFileUploadPart({
      path: {
        uploadId: input.uploadId,
        partNumber: partNumber.toString(),
      },
      client: input.client,
      throwOnError: true,
    })
    const response = await input.fetch(signedPart.url, {
      method: signedPart.method,
      headers: signedPart.headers,
      body: input.file.slice(offset, Math.min(input.file.size, offset + input.partSizeBytes)),
    })
    if (!response.ok) {
      throw new Error(
        `[SixbClient] Multipart file upload part ${partNumber} failed with HTTP ${response.status}.`
      )
    }

    const etag = response.headers.get("etag")
    if (!etag) {
      throw new Error(`[SixbClient] Multipart file upload part ${partNumber} did not return ETag.`)
    }
    parts.push({ partNumber, etag })
    partNumber += 1
  }

  return parts
}

async function sha256Blob(file: File | Blob): Promise<FileRef["digest"]> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("[SixbClient] Web Crypto is required to hash staged file uploads.")
  }

  const bytes = await file.arrayBuffer()
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes)
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  return `sha256:${hex}`
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

function toFileRef(value: Omit<FileRef, "digest"> & { readonly digest: string }): FileRef {
  if (!value.digest.startsWith("sha256:")) {
    throw new Error("[SixbClient] File upload response did not include a sha256 digest.")
  }

  return {
    ...value,
    digest: value.digest as FileRef["digest"],
  }
}
