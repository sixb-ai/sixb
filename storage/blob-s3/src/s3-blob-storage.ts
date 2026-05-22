import {
  type BlobInfo,
  type BlobStorage,
  BlobStorageError,
  blobDigestHex,
  blobIdFromDigest,
  computeBlobDigest,
  createFileRef,
  type FileRef,
  type PutBlobInput,
  readBlobBody,
} from "@pario/core"
import { S3Client } from "bun"
import type { S3BlobStorageOptions } from "./types"

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

export class S3BlobStorage implements BlobStorage {
  private readonly basePath: string
  private readonly client: S3Client

  constructor(options: S3BlobStorageOptions = {}) {
    this.basePath = normalizeS3BlobBasePath(options.basePath ?? "pario")
    this.client = new S3Client({
      bucket: options.bucket,
      region: options.region,
      endpoint: options.endpoint,
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      sessionToken: options.sessionToken,
      acl: options.acl,
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
}
