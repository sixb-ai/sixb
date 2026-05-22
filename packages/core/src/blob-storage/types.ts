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
