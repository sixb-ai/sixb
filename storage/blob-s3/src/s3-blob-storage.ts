import { Buffer } from "node:buffer"
import { randomUUID } from "node:crypto"
import {
  type BlobByteRange,
  type BlobDigest,
  type BlobInfo,
  type BlobStorage,
  blobDigestHex,
  blobIdFromDigest,
  type FileRef,
} from "@sixb/core"
import {
  type AbortBlobUploadInput,
  assertExpectedBlobSize,
  assertValidExpectedBlobSize,
  BlobStorageError,
  type BlobUploadSession,
  type CompleteBlobUploadInput,
  type CreateBlobUploadInput,
  createFileRef,
  type DirectUploadBlobStorage,
  type PutBlobInput,
  type RangeReadableBlobStorage,
  type SignBlobUploadPartInput,
  type SignedBlobUploadPart,
  streamBlobBody,
} from "@sixb/core/blob-storage/server"
import { createAwsS3Api, type S3Api } from "./aws-s3-api"
import { uploadBlobStreamToS3 } from "./s3-multipart-upload"
import type { S3BlobStorageOptions } from "./types"

const MAX_PRESIGNED_URL_EXPIRES_SECONDS = 7 * 24 * 60 * 60 // 7 days
const MIN_S3_MULTIPART_PART_SIZE_BYTES = 5 * 1024 * 1024
const DEFAULT_PUT_PART_SIZE_BYTES = 8 * 1024 * 1024
const DEFAULT_PUT_CONCURRENCY = 2
const DEFAULT_PUT_RETRIES = 3

export function normalizeS3BlobBasePath(basePath: string): string {
  return basePath
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join("/")
}

export function s3BlobHexFromBlobId(blobId: string): string | null {
  if (!/^blob_[a-f0-9]{64}$/.test(blobId)) {
    return null
  }

  return blobId.slice("blob_".length)
}

export function s3BlobKeyForHex(basePath: string, hex: string): string {
  return basePath ? `${basePath}/blobs/sha256/${hex}` : `blobs/sha256/${hex}`
}

function isMissingS3ObjectError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false
  }

  const record = error as Record<string, unknown>
  const metadata = record.$metadata as { httpStatusCode?: unknown } | undefined
  // AWS and S3-compatible backends surface missing objects with slightly different names.
  return (
    record.name === "NoSuchKey" ||
    record.name === "NotFound" ||
    record.code === "NoSuchKey" ||
    record.status === 404 ||
    record.statusCode === 404 ||
    metadata?.httpStatusCode === 404
  )
}

function envValue(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]
    if (value && value.trim().length > 0) {
      return value
    }
  }

  return undefined
}

function inferRegionFromEndpoint(endpoint: string | undefined): string | undefined {
  if (!endpoint) {
    return undefined
  }

  try {
    const hostname = new URL(endpoint).hostname
    return hostname.match(/^([a-z0-9-]+)\.digitaloceanspaces\.com$/)?.[1]
  } catch {
    return undefined
  }
}

function defaultPathStyle(endpoint: string | undefined): boolean {
  if (!endpoint) {
    return false
  }

  try {
    const hostname = new URL(endpoint).hostname
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)
    )
  } catch {
    return false
  }
}

function checksumBase64(digest: BlobDigest): string {
  return Buffer.from(blobDigestHex(digest), "hex").toString("base64")
}

export class S3BlobStorage
  implements BlobStorage, DirectUploadBlobStorage, RangeReadableBlobStorage
{
  private readonly basePath: string
  private readonly putPartSizeBytes: number
  private readonly putConcurrency: number
  private readonly api: S3Api

  constructor(options: S3BlobStorageOptions = {}) {
    this.basePath = normalizeS3BlobBasePath(options.basePath ?? "sixb")
    const bucket = options.bucket ?? envValue("S3_BUCKET", "AWS_BUCKET")
    const endpoint = options.endpoint ?? envValue("S3_ENDPOINT", "AWS_ENDPOINT")
    const region =
      options.region ??
      envValue("S3_REGION", "AWS_REGION") ??
      inferRegionFromEndpoint(endpoint) ??
      "us-east-1"
    const accessKeyId = options.accessKeyId ?? envValue("S3_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID")
    const secretAccessKey =
      options.secretAccessKey ?? envValue("S3_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY")
    const sessionToken = options.sessionToken ?? envValue("S3_SESSION_TOKEN", "AWS_SESSION_TOKEN")
    const pathStyle = options.pathStyle ?? defaultPathStyle(endpoint)
    this.putPartSizeBytes = requireIntegerOption(
      "putPartSizeBytes",
      options.putPartSizeBytes ?? DEFAULT_PUT_PART_SIZE_BYTES,
      MIN_S3_MULTIPART_PART_SIZE_BYTES
    )
    this.putConcurrency = requireIntegerOption(
      "putConcurrency",
      options.putConcurrency ?? DEFAULT_PUT_CONCURRENCY,
      1,
      255
    )
    const putRetries = requireIntegerOption(
      "putRetries",
      options.putRetries ?? DEFAULT_PUT_RETRIES,
      0,
      255
    )
    this.api = createAwsS3Api({
      bucket,
      region,
      retries: putRetries,
      pathStyle,
      ...(endpoint === undefined ? {} : { endpoint }),
      ...(accessKeyId === undefined ? {} : { accessKeyId }),
      ...(secretAccessKey === undefined ? {} : { secretAccessKey }),
      ...(sessionToken === undefined ? {} : { sessionToken }),
      ...(options.acl === undefined ? {} : { acl: options.acl }),
    })
  }

  async put(input: PutBlobInput): Promise<FileRef> {
    assertValidExpectedBlobSize(input.expectedSizeBytes, "BlobS3")
    input.signal?.throwIfAborted()
    const stagingKey = this.uploadKeyForId(`put_${randomUUID().replaceAll("-", "")}`)

    try {
      const { digest, sizeBytes } = await uploadBlobStreamToS3({
        stream: streamBlobBody(input.body),
        api: this.api,
        key: stagingKey,
        partSizeBytes: this.putPartSizeBytes,
        concurrency: this.putConcurrency,
        expectedSizeBytes: input.expectedSizeBytes,
        signal: input.signal,
        mediaType: input.mediaType,
      })

      const staged = await this.api.headObject({ key: stagingKey })
      assertExpectedBlobSize(sizeBytes, staged.sizeBytes, "BlobS3")
      input.signal?.throwIfAborted()

      const info: BlobInfo = {
        blobId: blobIdFromDigest(digest),
        digest,
        sizeBytes,
      }

      await this.copyObject(stagingKey, this.contentKeyForHex(blobDigestHex(digest)))
      await this.api.deleteObject(stagingKey)
      return createFileRef(input, info)
    } catch (error) {
      await this.deleteStagedObjectQuietly(stagingKey)
      throw error
    }
  }

  async createUpload(input: CreateBlobUploadInput): Promise<BlobUploadSession> {
    if (!input.expectedDigest || input.sizeBytes === undefined) {
      throw new BlobStorageError(
        "[BlobS3] Direct staged uploads require an expected digest and size."
      )
    }

    const stagingKey = this.uploadKeyForId(input.uploadId)
    const expiresIn = this.expiresInSeconds(input.expiresAt)
    const signed = await this.api.presignPutObject({
      key: stagingKey,
      checksumSha256: checksumBase64(input.expectedDigest),
      expiresInSeconds: expiresIn,
      ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType }),
    })

    return {
      strategy: "direct-put",
      uploadId: input.uploadId,
      method: "PUT",
      url: signed.url,
      headers: signed.headers,
      expiresAt: input.expiresAt,
      stagingKey,
    }
  }

  async signUploadPart(_input: SignBlobUploadPartInput): Promise<SignedBlobUploadPart> {
    throw new BlobStorageError("[BlobS3] Multipart staged uploads are not supported yet.")
  }

  async completeUpload(input: CompleteBlobUploadInput): Promise<FileRef> {
    if (input.parts && input.parts.length > 0) {
      throw new BlobStorageError("[BlobS3] Multipart staged uploads are not supported yet.")
    }

    if (!input.expectedDigest || input.expectedSizeBytes === undefined) {
      throw new BlobStorageError(
        "[BlobS3] Completing a direct staged upload requires an expected digest and size."
      )
    }

    const staged = await this.headStagedObject(input.stagingKey)
    if (staged.sizeBytes !== input.expectedSizeBytes) {
      throw new BlobStorageError(
        `[BlobS3] Staged upload '${input.uploadId}' size mismatch: expected ${input.expectedSizeBytes} bytes, received ${staged.sizeBytes}.`
      )
    }

    // Fail closed on integrity: the presigned PUT required an x-amz-checksum-sha256, so the backend
    // must report the same value it verified against the stored bytes. The bytes never transit Sixb,
    // so this HEAD is the only proof they match the client-declared digest — without it we would be
    // trusting unverified client input, which defeats the point of a content-addressed store.
    const expectedChecksum = checksumBase64(input.expectedDigest)
    if (staged.checksumSha256 === null) {
      throw new BlobStorageError(
        `[BlobS3] Staged upload '${input.uploadId}' has no backend-verified sha256 checksum; refusing to promote unverified bytes.`
      )
    }
    if (staged.checksumSha256 !== expectedChecksum) {
      throw new BlobStorageError(
        `[BlobS3] Staged upload '${input.uploadId}' checksum mismatch: the stored object does not match the expected digest.`
      )
    }

    const finalKey = this.contentKeyForHex(blobDigestHex(input.expectedDigest))
    await this.copyObject(input.stagingKey, finalKey)
    await this.api.deleteObject(input.stagingKey)

    return {
      blobId: blobIdFromDigest(input.expectedDigest),
      digest: input.expectedDigest,
      sizeBytes: input.expectedSizeBytes,
      ...(input.fileName === undefined ? {} : { fileName: input.fileName }),
      ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType }),
      ...(input.logicalPath === undefined ? {} : { logicalPath: input.logicalPath }),
    }
  }

  async abortUpload(input: AbortBlobUploadInput): Promise<void> {
    try {
      await this.api.deleteObject(input.stagingKey)
    } catch (error) {
      if (!isMissingS3ObjectError(error)) {
        throw error
      }
    }
  }

  async open(blobId: string): Promise<ReadableStream<Uint8Array>> {
    const hex = s3BlobHexFromBlobId(blobId)
    if (!hex) {
      throw new BlobStorageError(`[BlobS3] Invalid blob id '${blobId}'`)
    }

    return this.streamObject(blobId, this.contentKeyForHex(hex))
  }

  async openRange(blobId: string, range: BlobByteRange): Promise<ReadableStream<Uint8Array>> {
    const hex = s3BlobHexFromBlobId(blobId)
    if (!hex) {
      throw new BlobStorageError(`[BlobS3] Invalid blob id '${blobId}'`)
    }

    return this.streamObject(blobId, this.contentKeyForHex(hex), range)
  }

  async stat(blobId: string): Promise<BlobInfo | null> {
    const hex = s3BlobHexFromBlobId(blobId)
    if (!hex) {
      return null
    }

    try {
      const stat = await this.api.headObject({ key: this.contentKeyForHex(hex) })
      return {
        blobId,
        digest: `sha256:${hex}`,
        sizeBytes: stat.sizeBytes,
      }
    } catch (error) {
      if (isMissingS3ObjectError(error)) {
        return null
      }

      throw error
    }
  }

  // Single-request read whose 404 maps to a clean not-found before any body is streamed, avoiding
  // the extra HEAD round-trip a pre-stat adds.
  private async streamObject(
    blobId: string,
    key: string,
    range?: BlobByteRange
  ): Promise<ReadableStream<Uint8Array>> {
    try {
      return await this.api.getObject({
        key,
        ...(range === undefined ? {} : { range }),
      })
    } catch (error) {
      if (isMissingS3ObjectError(error)) {
        throw new BlobStorageError(`[BlobS3] Unknown blob '${blobId}'`)
      }
      throw error
    }
  }

  private async headStagedObject(
    stagingKey: string
  ): Promise<{ readonly sizeBytes: number; readonly checksumSha256: string | null }> {
    try {
      const head = await this.api.headObject({ key: stagingKey, checksumMode: true })
      return {
        sizeBytes: head.sizeBytes,
        checksumSha256: head.checksumSha256 ?? null,
      }
    } catch (error) {
      if (isMissingS3ObjectError(error)) {
        throw new BlobStorageError(`[BlobS3] Staged upload object '${stagingKey}' was not found.`)
      }
      throw error
    }
  }

  private contentKeyForHex(hex: string): string {
    return s3BlobKeyForHex(this.basePath, hex)
  }

  private uploadKeyForId(uploadId: string): string {
    return this.basePath
      ? `${this.basePath}/uploads/${uploadId}/object`
      : `uploads/${uploadId}/object`
  }

  private async deleteStagedObjectQuietly(stagingKey: string): Promise<void> {
    try {
      await this.api.deleteObject(stagingKey)
    } catch {
      // Preserve the upload failure. Bucket lifecycle rules are the final cleanup safety net.
    }
  }

  private async copyObject(sourceKey: string, destinationKey: string): Promise<void> {
    await this.api.copyObject(sourceKey, destinationKey)
  }

  private expiresInSeconds(expiresAt: Date): number {
    return Math.min(
      MAX_PRESIGNED_URL_EXPIRES_SECONDS,
      Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 1000))
    )
  }
}

function requireIntegerOption(
  name: string,
  value: number,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new BlobStorageError(
      `[BlobS3] ${name} must be an integer between ${minimum} and ${maximum}.`
    )
  }

  return value
}
