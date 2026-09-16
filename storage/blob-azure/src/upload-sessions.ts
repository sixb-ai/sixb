import type { BlockBlobClient } from "@azure/storage-blob"
import { type BlobDigest, BlobStorageError } from "@sixb/core/blob-storage/server"
import { azureErrorCode, webStream } from "./azure-client"

export interface UploadRecord {
  readonly partSizeBytes?: number
  readonly version: 1
  readonly digest: BlobDigest
  readonly sizeBytes: number
  readonly expiresAt: number
  readonly status: "pending" | "completed" | "aborted"
}

export function isSha256(value: unknown): value is BlobDigest {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value)
}

export async function readUploadRecord(blob: BlockBlobClient, signal?: AbortSignal) {
  try {
    // Records are provider-owned, small JSON documents; bound reads even if one is corrupted.
    const response = await blob.download(0, 4097, { abortSignal: signal })
    const text = await new Response(webStream(response.readableStreamBody)).text()
    if (text.length > 4096 || !response.etag)
      throw new Error("[BlobAzure] Invalid upload record size or ETag.")
    const value: unknown = JSON.parse(text)
    if (!isUploadRecord(value)) throw new Error("[BlobAzure] Invalid upload record fields.")
    return { record: value, etag: response.etag }
  } catch (error) {
    if (azureErrorCode(error) === "BlobNotFound") return null
    throw error
  }
}

export async function writeUploadRecord(
  blob: BlockBlobClient,
  record: UploadRecord,
  etag?: string,
  signal?: AbortSignal
): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify(record))
  await blob.upload(bytes, bytes.byteLength, {
    abortSignal: signal,
    conditions: etag ? { ifMatch: etag } : { ifNoneMatch: "*" },
    blobHTTPHeaders: { blobContentType: "application/json" },
  })
}

export function requireUploadIdentity(
  record: UploadRecord,
  digest: BlobDigest,
  sizeBytes: number
): void {
  if (record.digest !== digest || record.sizeBytes !== sizeBytes) {
    throw new BlobStorageError("[BlobAzure] Completion identity differs from the upload session.")
  }
}

function isUploadRecord(value: unknown): value is UploadRecord {
  if (typeof value !== "object" || value === null) return false
  if (
    "partSizeBytes" in value &&
    (typeof value.partSizeBytes !== "number" ||
      !Number.isSafeInteger(value.partSizeBytes) ||
      value.partSizeBytes <= 0)
  )
    return false
  return (
    "version" in value &&
    value.version === 1 &&
    "digest" in value &&
    isSha256(value.digest) &&
    "sizeBytes" in value &&
    typeof value.sizeBytes === "number" &&
    Number.isSafeInteger(value.sizeBytes) &&
    value.sizeBytes >= 0 &&
    "expiresAt" in value &&
    typeof value.expiresAt === "number" &&
    Number.isSafeInteger(value.expiresAt) &&
    "status" in value &&
    (value.status === "pending" || value.status === "completed" || value.status === "aborted")
  )
}
