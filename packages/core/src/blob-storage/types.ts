export type BlobDigest = `sha256:${string}`

/**
 * Dataset-safe reference to immutable blob bytes stored outside lake rows.
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

export interface MultipartBlobUploadSession {
  readonly strategy: "multipart"
  readonly uploadId: string
  readonly partSizeBytes: number
  readonly expiresAt: Date
  readonly stagingKey: string
  readonly providerUploadId: string
}

export type BlobUploadSession = DirectPutBlobUploadSession | MultipartBlobUploadSession

export interface SignBlobUploadPartInput {
  readonly uploadId: string
  readonly stagingKey: string
  readonly providerUploadId?: string
  readonly partNumber: number
  readonly expiresAt: Date
}

export interface SignedBlobUploadPart {
  readonly partNumber: number
  readonly method: "PUT"
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly expiresAt: Date
}

export interface BlobUploadPart {
  readonly partNumber: number
  readonly etag: string
}

export interface CompleteBlobUploadInput {
  readonly uploadId: string
  readonly stagingKey: string
  readonly providerUploadId?: string
  readonly fileName?: string
  readonly mediaType?: string
  readonly logicalPath?: string
  readonly expectedSizeBytes?: number
  readonly expectedDigest?: BlobDigest
  readonly parts?: readonly BlobUploadPart[]
}

export interface AbortBlobUploadInput {
  readonly uploadId: string
  readonly stagingKey: string
  readonly providerUploadId?: string
}

export interface DirectUploadBlobStorage {
  createUpload(input: CreateBlobUploadInput): Promise<BlobUploadSession>
  signUploadPart(input: SignBlobUploadPartInput): Promise<SignedBlobUploadPart>
  completeUpload(input: CompleteBlobUploadInput): Promise<FileRef>
  abortUpload(input: AbortBlobUploadInput): Promise<void>
}
