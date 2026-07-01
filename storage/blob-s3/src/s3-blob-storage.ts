import { Buffer } from "node:buffer"
import {
  type AbortBlobUploadInput,
  type BlobByteRange,
  type BlobDigest,
  type BlobInfo,
  type BlobStorage,
  BlobStorageError,
  type BlobUploadSession,
  blobDigestHex,
  blobIdFromDigest,
  type CompleteBlobUploadInput,
  type CreateBlobUploadInput,
  computeBlobDigest,
  createFileRef,
  type DirectUploadBlobStorage,
  type FileRef,
  type PutBlobInput,
  type RangeReadableBlobStorage,
  readBlobBody,
} from "@sixb/core"
import { S3Client } from "bun"
import { encodeRfc3986, encodeS3Path, presignS3Url } from "./sigv4"
import type { S3BlobStorageAcl, S3BlobStorageOptions } from "./types"

const MAX_PRESIGNED_URL_EXPIRES_SECONDS = 7 * 24 * 60 * 60 // 7 days
const READ_URL_EXPIRES_SECONDS = 60

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
  // Bun and S3-compatible backends surface missing objects with slightly different shapes.
  return (
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
  private readonly bucket: string | undefined
  private readonly region: string
  private readonly endpoint: string | undefined
  private readonly accessKeyId: string | undefined
  private readonly secretAccessKey: string | undefined
  private readonly sessionToken: string | undefined
  private readonly acl: S3BlobStorageAcl | undefined
  private readonly pathStyle: boolean
  private readonly client: S3Client

  constructor(options: S3BlobStorageOptions = {}) {
    this.basePath = normalizeS3BlobBasePath(options.basePath ?? "sixb")
    this.bucket = options.bucket ?? envValue("S3_BUCKET", "AWS_BUCKET")
    this.endpoint = options.endpoint ?? envValue("S3_ENDPOINT", "AWS_ENDPOINT")
    this.region =
      options.region ??
      envValue("S3_REGION", "AWS_REGION") ??
      inferRegionFromEndpoint(this.endpoint) ??
      "us-east-1"
    this.accessKeyId = options.accessKeyId ?? envValue("S3_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID")
    this.secretAccessKey =
      options.secretAccessKey ?? envValue("S3_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY")
    this.sessionToken = options.sessionToken ?? envValue("S3_SESSION_TOKEN", "AWS_SESSION_TOKEN")
    this.acl = options.acl
    this.pathStyle = options.pathStyle ?? defaultPathStyle(this.endpoint)
    this.client = new S3Client({
      bucket: this.bucket,
      region: this.region,
      endpoint: this.endpoint,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      sessionToken: this.sessionToken,
      acl: this.acl,
    })
  }

  async put(input: PutBlobInput): Promise<FileRef> {
    const bytes = await readBlobBody(input.body)
    const digest = computeBlobDigest(bytes)
    const hex = blobDigestHex(digest)
    const info: BlobInfo = {
      blobId: blobIdFromDigest(digest),
      digest,
      sizeBytes: bytes.byteLength,
    }

    await this.client.write(this.contentKeyForHex(hex), bytes, {
      type: input.mediaType,
    })

    return createFileRef(input, info)
  }

  async createUpload(input: CreateBlobUploadInput): Promise<BlobUploadSession> {
    if (!input.expectedDigest || input.sizeBytes === undefined) {
      throw new BlobStorageError(
        "[BlobS3] Direct staged uploads require an expected digest and size."
      )
    }

    const stagingKey = this.uploadKeyForId(input.uploadId)
    const expiresIn = this.expiresInSeconds(input.expiresAt)
    const headers: Record<string, string> = {
      "x-amz-checksum-sha256": checksumBase64(input.expectedDigest),
      ...(input.mediaType === undefined ? {} : { "content-type": input.mediaType }),
      ...(this.acl === undefined ? {} : { "x-amz-acl": this.acl }),
    }

    return {
      strategy: "direct-put",
      uploadId: input.uploadId,
      method: "PUT",
      url: this.presignUrl("PUT", stagingKey, headers, expiresIn),
      headers,
      expiresAt: input.expiresAt,
      stagingKey,
    }
  }

  async completeUpload(input: CompleteBlobUploadInput): Promise<FileRef> {
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
    await this.client.delete(input.stagingKey)

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
      await this.client.delete(input.stagingKey)
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
      const stat = await this.client.stat(this.contentKeyForHex(hex))
      return {
        blobId,
        digest: `sha256:${hex}`,
        sizeBytes: stat.size,
      }
    } catch (error) {
      if (isMissingS3ObjectError(error)) {
        return null
      }

      throw error
    }
  }

  // Single-request read: a signed GET (plus an optional, unsigned Range header) whose 404 maps to a
  // clean not-found before any body is streamed, avoiding the extra HEAD round-trip a pre-stat adds.
  private async streamObject(
    blobId: string,
    key: string,
    range?: BlobByteRange
  ): Promise<ReadableStream<Uint8Array>> {
    const url = this.presignUrl("GET", key, {}, READ_URL_EXPIRES_SECONDS)
    const response = await fetch(url, {
      headers: range ? { range: `bytes=${range.start}-${range.endInclusive}` } : {},
    })

    if (response.status === 404) {
      throw new BlobStorageError(`[BlobS3] Unknown blob '${blobId}'`)
    }
    if (!response.ok || !response.body) {
      throw new BlobStorageError(
        `[BlobS3] Failed to read blob '${blobId}': HTTP ${response.status}.`
      )
    }

    return response.body
  }

  private async headStagedObject(
    stagingKey: string
  ): Promise<{ readonly sizeBytes: number; readonly checksumSha256: string | null }> {
    const headers = { "x-amz-checksum-mode": "ENABLED" }
    const url = this.presignUrl("HEAD", stagingKey, headers, READ_URL_EXPIRES_SECONDS)
    const response = await fetch(url, { method: "HEAD", headers })

    if (response.status === 404) {
      throw new BlobStorageError(`[BlobS3] Staged upload object '${stagingKey}' was not found.`)
    }
    if (!response.ok) {
      throw new BlobStorageError(
        `[BlobS3] Failed to inspect staged upload '${stagingKey}': HTTP ${response.status}.`
      )
    }

    const contentLength = response.headers.get("content-length")
    return {
      sizeBytes: contentLength === null ? Number.NaN : Number(contentLength),
      checksumSha256: response.headers.get("x-amz-checksum-sha256"),
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

  private async copyObject(sourceKey: string, destinationKey: string): Promise<void> {
    const headers: Record<string, string> = {
      "x-amz-copy-source": this.copySourceHeader(sourceKey),
      ...(this.acl === undefined ? {} : { "x-amz-acl": this.acl }),
    }
    const url = this.presignUrl("PUT", destinationKey, headers, 60)
    const response = await fetch(url, {
      method: "PUT",
      headers,
    })

    if (!response.ok) {
      const message = await response.text().catch(() => "")
      throw new BlobStorageError(
        `[BlobS3] Failed to promote staged upload with S3 CopyObject: HTTP ${response.status}${message ? ` ${message}` : ""}`
      )
    }
  }

  private copySourceHeader(key: string): string {
    const { bucket } = this.requireSigningConfig()
    return `/${encodeRfc3986(bucket)}/${encodeS3Path(key)}`
  }

  private expiresInSeconds(expiresAt: Date): number {
    return Math.min(
      MAX_PRESIGNED_URL_EXPIRES_SECONDS,
      Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 1000))
    )
  }

  private presignUrl(
    method: string,
    key: string,
    headers: Readonly<Record<string, string>>,
    expiresInSeconds: number
  ): string {
    const config = this.requireSigningConfig()
    return presignS3Url({
      method,
      key,
      headers,
      expiresInSeconds,
      bucket: config.bucket,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      region: this.region,
      endpoint: this.endpoint,
      pathStyle: this.pathStyle,
      ...(this.sessionToken === undefined ? {} : { sessionToken: this.sessionToken }),
      now: new Date(),
    })
  }

  private requireSigningConfig(): {
    readonly bucket: string
    readonly accessKeyId: string
    readonly secretAccessKey: string
  } {
    if (!this.bucket || !this.accessKeyId || !this.secretAccessKey) {
      throw new BlobStorageError(
        "[BlobS3] Direct staged uploads require bucket, access key id, and secret access key configuration."
      )
    }

    return {
      bucket: this.bucket,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
    }
  }
}
