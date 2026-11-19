import { createHash } from "node:crypto"
import { createReadStream, openAsBlob } from "node:fs"
import { stat } from "node:fs/promises"
import { basename } from "node:path"
import { Readable } from "node:stream"
import type { ApiClient } from "./api-client"
import { CliError, EXIT_API, fail } from "./output"

// `sixb files upload`: a small file in one request, a larger one staged. A staged upload reads the
// file twice from disk, once for its SHA-256 and once to send it, and never holds it in memory: the
// API checks the bytes it receives against that digest before it issues the file.

/**
 * The API's simple-upload ceiling (`DEFAULT_SIMPLE_FILE_UPLOAD_BYTES` in `@sixb/core`): a larger
 * file is uploaded staged. The CLI imports no Sixb package, so it restates the API's contract.
 */
const SIMPLE_UPLOAD_MAX_BYTES = 25 * 1024 * 1024
const READ_CHUNK_BYTES = 1024 * 1024

/** How far an upload is: the file read for its digest, then its bytes sent. */
export interface UploadProgress {
  readonly stage: "hash" | "upload"
  readonly loadedBytes: number
  readonly totalBytes: number
}

export interface UploadFileOptions {
  readonly logicalPath?: string
  /** Without it, the API reads the type from the file's name. */
  readonly mediaType?: string
  readonly onProgress?: (progress: UploadProgress) => void
}

/** The staged upload `POST /api/files/uploads` opened, as the API describes it. */
type StagedUpload =
  | { readonly strategy: "server"; readonly uploadId: string; readonly url: string }
  | {
      readonly strategy: "direct-put"
      readonly uploadId: string
      readonly url: string
      readonly headers: Readonly<Record<string, string>>
    }
  | {
      readonly strategy: "multipart"
      readonly uploadId: string
      readonly partSizeBytes: number
      readonly partReceipt: "etag" | "none"
    }

/** Uploads a local file and resolves to the FileRef the API issued for it. */
export async function uploadFile(
  api: ApiClient,
  source: string,
  options: UploadFileOptions = {}
): Promise<unknown> {
  const sizeBytes = await regularFileSize(source)
  if (sizeBytes <= SIMPLE_UPLOAD_MAX_BYTES) {
    const fileRef = await api.upload("/api/files", source, options.logicalPath, options.mediaType)
    options.onProgress?.({ stage: "upload", loadedBytes: sizeBytes, totalBytes: sizeBytes })
    return fileRef
  }

  const progress = (stage: UploadProgress["stage"], loadedBytes: number) =>
    options.onProgress?.({ stage, loadedBytes, totalBytes: sizeBytes })
  const digest = await fileDigest(source, (hashedBytes) => progress("hash", hashedBytes))

  const upload = stagedUpload(
    await api.post("/api/files/uploads", {
      fileName: basename(source),
      ...(options.mediaType ? { mediaType: options.mediaType } : {}),
      sizeBytes,
      digest,
      ...(options.logicalPath ? { logicalPath: options.logicalPath } : {}),
      ...(api.uploadsThroughApi ? { strategy: "server" } : {}),
    })
  )

  try {
    progress("upload", 0)
    const parts = await sendContent(api, upload, source, sizeBytes, (sentBytes) =>
      progress("upload", sentBytes)
    )
    return await api.post(`/api/files/uploads/${encodeURIComponent(upload.uploadId)}/complete`, {
      digest,
      sizeBytes,
      ...(parts ? { parts } : {}),
    })
  } catch (error) {
    // Releases what the session holds; its own failure must not hide why the upload stopped.
    await api
      .post(`/api/files/uploads/${encodeURIComponent(upload.uploadId)}/abort`, {})
      .catch(() => {})
    throw error
  }
}

/**
 * Sends the file as the session asks: through the API, to one signed URL, or in signed parts.
 * Resolves to the parts sent, which completing the upload names.
 */
async function sendContent(
  api: ApiClient,
  upload: StagedUpload,
  source: string,
  sizeBytes: number,
  onSent: (sentBytes: number) => void
): Promise<{ readonly partNumber: number; readonly etag?: string }[] | undefined> {
  if (upload.strategy === "server") {
    await api.put(upload.url, fileStream(source, { onBytes: onSent }), sizeBytes)
    return undefined
  }

  // A signed URL takes the file as a sized body: object stores refuse chunks of unknown length.
  const file = await openAsBlob(source)
  if (upload.strategy === "direct-put") {
    await signedPut(upload.url, upload.headers, file)
    onSent(sizeBytes)
    return undefined
  }

  const parts: { readonly partNumber: number; readonly etag?: string }[] = []
  for (let offset = 0, partNumber = 1; offset < sizeBytes; partNumber += 1) {
    const end = Math.min(sizeBytes, offset + upload.partSizeBytes)
    const signed = signedPart(
      await api.post(
        `/api/files/uploads/${encodeURIComponent(upload.uploadId)}/parts/${partNumber}`,
        {}
      )
    )
    const etag = await signedPut(signed.url, signed.headers, file.slice(offset, end))
    if (upload.partReceipt === "etag" && !etag) {
      throw uploadFailed(`Part ${partNumber} of the upload returned no ETag.`)
    }

    parts.push(upload.partReceipt === "etag" && etag ? { partNumber, etag } : { partNumber })
    onSent(end)
    offset = end
  }
  return parts
}

/** One PUT to a URL blob storage signed; resolves to the ETag it answered, if any. */
async function signedPut(
  url: string,
  headers: Readonly<Record<string, string>>,
  body: Blob
): Promise<string | null> {
  let response: Response
  try {
    response = await fetch(url, { method: "PUT", headers, body })
  } catch {
    throw uploadFailed("Blob storage could not be reached to upload the file.")
  }
  if (!response.ok) {
    throw uploadFailed(`Blob storage refused the upload with HTTP ${response.status}.`)
  }
  return response.headers.get("etag")
}

async function regularFileSize(source: string): Promise<number> {
  const info = await stat(source).catch(() => null)
  if (!info) fail(`Upload file '${source}' does not exist.`)
  if (!info.isFile()) fail(`Upload file '${source}' is not a regular file.`)
  return info.size
}

/** The file's SHA-256, as the API names a digest, read a chunk at a time. */
async function fileDigest(
  source: string,
  onBytes: (hashedBytes: number) => void
): Promise<`sha256:${string}`> {
  const hash = createHash("sha256")
  let hashedBytes = 0
  for await (const chunk of createReadStream(source, { highWaterMark: READ_CHUNK_BYTES })) {
    hash.update(chunk as Buffer)
    hashedBytes += (chunk as Buffer).byteLength
    onBytes(hashedBytes)
  }
  return `sha256:${hash.digest("hex")}`
}

/** The file as a web stream, counting what the request has read of it. */
function fileStream(
  source: string,
  options: { readonly onBytes: (readBytes: number) => void }
): ReadableStream<Uint8Array> {
  const stream = Readable.toWeb(
    createReadStream(source, { highWaterMark: READ_CHUNK_BYTES })
  ) as unknown as ReadableStream<Uint8Array>
  let readBytes = 0
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        readBytes += chunk.byteLength
        options.onBytes(readBytes)
        controller.enqueue(chunk)
      },
    })
  )
}

function stagedUpload(value: unknown): StagedUpload {
  const upload = value as Partial<Record<string, unknown>> | null
  const uploadId = upload?.uploadId
  if (typeof uploadId !== "string") throw invalidResponse()

  if (upload?.strategy === "server" && typeof upload.url === "string") {
    return { strategy: "server", uploadId, url: upload.url }
  }
  if (upload?.strategy === "direct-put" && typeof upload.url === "string") {
    return {
      strategy: "direct-put",
      uploadId,
      url: upload.url,
      headers: stringRecord(upload.headers),
    }
  }
  if (
    upload?.strategy === "multipart" &&
    typeof upload.partSizeBytes === "number" &&
    upload.partSizeBytes > 0
  ) {
    return {
      strategy: "multipart",
      uploadId,
      partSizeBytes: upload.partSizeBytes,
      partReceipt: upload.partReceipt === "none" ? "none" : "etag",
    }
  }
  throw invalidResponse()
}

function signedPart(value: unknown): {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
} {
  const part = value as Partial<Record<string, unknown>> | null
  if (typeof part?.url !== "string") throw invalidResponse()
  return { url: part.url, headers: stringRecord(part.headers) }
}

function stringRecord(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  )
}

function invalidResponse(): CliError {
  return new CliError(
    {
      code: "invalid_api_response",
      message: "The Sixb API described the upload in a way the CLI does not know.",
    },
    EXIT_API
  )
}

function uploadFailed(message: string): CliError {
  return new CliError({ code: "upload_failed", message }, EXIT_API)
}
