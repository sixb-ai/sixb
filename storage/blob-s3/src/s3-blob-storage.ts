import { Buffer } from "node:buffer"
import { createHash, createHmac } from "node:crypto"
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
  type SignBlobUploadPartInput,
  type SignedBlobUploadPart,
} from "@sixb/core"
import { S3Client } from "bun"
import type { S3BlobStorageAcl, S3BlobStorageOptions } from "./types"

const MAX_PRESIGNED_URL_EXPIRES_SECONDS = 7 * 24 * 60 * 60 // 7 days

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

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

function encodeS3Path(value: string): string {
  return value.split("/").map(encodeRfc3986).join("/")
}

function canonicalQueryString(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)] as const)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("&")
}

function normalizeHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, " ")
}

function canonicalSignedHeaders(headers: Readonly<Record<string, string>>): {
  readonly canonicalHeaders: string
  readonly signedHeaders: string
} {
  const entries = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), normalizeHeaderValue(value)] as const)
    .sort(([left], [right]) => left.localeCompare(right))

  return {
    canonicalHeaders: entries.map(([name, value]) => `${name}:${value}\n`).join(""),
    signedHeaders: entries.map(([name]) => name).join(";"),
  }
}

function formatAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "")
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest()
}

function signingKey(input: {
  readonly secretAccessKey: string
  readonly dateStamp: string
  readonly region: string
}): Buffer {
  const dateKey = hmac(`AWS4${input.secretAccessKey}`, input.dateStamp)
  const regionKey = hmac(dateKey, input.region)
  const serviceKey = hmac(regionKey, "s3")
  return hmac(serviceKey, "aws4_request")
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex")
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
      url: this.presignS3Request("PUT", stagingKey, headers, expiresIn),
      headers,
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

    const stat = await this.client.stat(input.stagingKey)
    if (stat.size !== input.expectedSizeBytes) {
      throw new BlobStorageError(
        `[BlobS3] Staged upload '${input.uploadId}' size mismatch: expected ${input.expectedSizeBytes} bytes, received ${stat.size}.`
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

    const key = this.contentKeyForHex(hex)
    if (!(await this.stat(blobId))) {
      throw new BlobStorageError(`[BlobS3] Unknown blob '${blobId}'`)
    }

    return this.client.file(key).stream()
  }

  async openRange(blobId: string, range: BlobByteRange): Promise<ReadableStream<Uint8Array>> {
    const hex = s3BlobHexFromBlobId(blobId)
    if (!hex) {
      throw new BlobStorageError(`[BlobS3] Invalid blob id '${blobId}'`)
    }

    const key = this.contentKeyForHex(hex)
    if (!(await this.stat(blobId))) {
      throw new BlobStorageError(`[BlobS3] Unknown blob '${blobId}'`)
    }

    return this.client
      .file(key)
      .slice(range.start, range.endInclusive + 1)
      .stream()
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
    const url = this.presignS3Request("PUT", destinationKey, headers, 60)
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

  private presignS3Request(
    method: "PUT",
    key: string,
    headers: Readonly<Record<string, string>>,
    expiresIn: number
  ): string {
    const config = this.requireSigningConfig()
    const url = this.objectUrl(key, config.bucket)
    const amzDate = formatAmzDate(new Date())
    const dateStamp = amzDate.slice(0, 8)
    const scope = `${dateStamp}/${this.region}/s3/aws4_request`
    const signingHeaders = {
      ...headers,
      host: url.host,
    }
    const { canonicalHeaders, signedHeaders } = canonicalSignedHeaders(signingHeaders)
    const query: Record<string, string> = {
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": `${config.accessKeyId}/${scope}`,
      "X-Amz-Date": amzDate,
      "X-Amz-Expires": expiresIn.toString(),
      "X-Amz-SignedHeaders": signedHeaders,
      ...(this.sessionToken === undefined ? {} : { "X-Amz-Security-Token": this.sessionToken }),
    }
    const canonicalRequest = [
      method,
      url.pathname,
      canonicalQueryString(query),
      canonicalHeaders,
      signedHeaders,
      "UNSIGNED-PAYLOAD",
    ].join("\n")
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join(
      "\n"
    )
    const signature = createHmac(
      "sha256",
      signingKey({
        secretAccessKey: config.secretAccessKey,
        dateStamp,
        region: this.region,
      })
    )
      .update(stringToSign)
      .digest("hex")

    url.search = canonicalQueryString({
      ...query,
      "X-Amz-Signature": signature,
    })
    return url.toString()
  }

  private objectUrl(key: string, bucket: string): URL {
    const encodedKey = encodeS3Path(key)
    if (!this.endpoint) {
      return new URL(`https://${bucket}.s3.${this.region}.amazonaws.com/${encodedKey}`)
    }

    const base = new URL(this.endpoint.endsWith("/") ? this.endpoint : `${this.endpoint}/`)
    if (this.pathStyle) {
      return new URL(`${encodeRfc3986(bucket)}/${encodedKey}`, base)
    }

    base.hostname = `${bucket}.${base.hostname}`
    base.pathname = `/${encodedKey}`
    base.search = ""
    return base
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
