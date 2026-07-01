export type BlobDigest = `sha256:${string}`

/**
 * Dataset-safe reference to immutable blob bytes stored outside lake rows.
 *
 * `blobId`, `digest`, and `sizeBytes` are the blob's content-addressed identity:
 * `blobId` is always `blob_<sha256 hex>` derived from `digest`. `fileName`,
 * `mediaType`, and `logicalPath` are caller-supplied per-reference metadata (not
 * part of blob identity) and are untrusted — consumers must sanitize them before
 * using them for paths, headers, or rendering.
 */
export interface FileRef {
  readonly blobId: string
  readonly digest: BlobDigest
  readonly sizeBytes: number
  readonly fileName?: string
  readonly mediaType?: string
  readonly logicalPath?: string
}

export interface PutBlobInput {
  readonly body: ArrayBuffer | Uint8Array | Blob | ReadableStream<Uint8Array>
  readonly fileName?: string
  readonly mediaType?: string
  readonly logicalPath?: string
}

export interface BlobInfo {
  readonly blobId: string
  readonly digest: BlobDigest
  readonly sizeBytes: number
}

/**
 * Durable content-addressed binary storage. Implementations should return the
 * same blob id and digest for identical bytes.
 */
export interface BlobStorage {
  put(input: PutBlobInput): Promise<FileRef>
  open(blobId: string): Promise<ReadableStream<Uint8Array>>
  stat(blobId: string): Promise<BlobInfo | null>
}

/**
 * Inclusive byte range `[start, endInclusive]` (both offsets are part of the
 * requested slice), matching HTTP `Range: bytes=start-end` semantics. Callers
 * validate the bounds against the blob size before requesting a range.
 */
export interface BlobByteRange {
  readonly start: number
  readonly endInclusive: number
}

export interface RangeReadableBlobStorage {
  openRange(blobId: string, range: BlobByteRange): Promise<ReadableStream<Uint8Array>>
}

export interface CreateBlobUploadInput {
  readonly uploadId: string
  readonly fileName?: string
  readonly mediaType?: string
  readonly logicalPath?: string
  readonly sizeBytes?: number
  readonly expectedDigest?: BlobDigest
  readonly expiresAt: Date
}

export interface DirectPutBlobUploadSession {
  readonly strategy: "direct-put"
  readonly uploadId: string
  readonly method: "PUT"
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly expiresAt: Date
  readonly stagingKey: string
  readonly providerUploadId?: string
}

// Only the direct-PUT staged upload strategy is supported. A multipart capability
// (mirroring RangeReadableBlobStorage/supportsRangeRead) can be reintroduced as its
// own interface once a provider backs it; keeping the union alias makes that a
// one-line change without churning every consumer.
export type BlobUploadSession = DirectPutBlobUploadSession

export interface CompleteBlobUploadInput {
  readonly uploadId: string
  readonly stagingKey: string
  readonly providerUploadId?: string
  readonly fileName?: string
  readonly mediaType?: string
  readonly logicalPath?: string
  readonly expectedSizeBytes?: number
  readonly expectedDigest?: BlobDigest
}

export interface AbortBlobUploadInput {
  readonly uploadId: string
  readonly stagingKey: string
  readonly providerUploadId?: string
}

export interface DirectUploadBlobStorage {
  createUpload(input: CreateBlobUploadInput): Promise<BlobUploadSession>
  completeUpload(input: CompleteBlobUploadInput): Promise<FileRef>
  abortUpload(input: AbortBlobUploadInput): Promise<void>
}
