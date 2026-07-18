export type S3BlobStorageAcl =
  | "private"
  | "public-read"
  | "public-read-write"
  | "aws-exec-read"
  | "authenticated-read"
  | "bucket-owner-read"
  | "bucket-owner-full-control"
  | "log-delivery-write"

export interface S3BlobStorageOptions {
  /** S3 bucket name. When omitted, S3_BUCKET or AWS_BUCKET is read from the environment. */
  readonly bucket?: string
  /** AWS region. For non-AWS providers, use endpoint instead. */
  readonly region?: string
  /** S3-compatible endpoint such as an R2, Spaces, or MinIO URL. */
  readonly endpoint?: string
  /** Access key id. When omitted, the AWS SDK credential provider chain is used. */
  readonly accessKeyId?: string
  /** Secret access key. When omitted, the AWS SDK credential provider chain is used. */
  readonly secretAccessKey?: string
  /** Optional session token for temporary credentials. */
  readonly sessionToken?: string
  /** Optional canned ACL applied to staged and content-addressed objects. */
  readonly acl?: S3BlobStorageAcl
  /**
   * Force path-style S3 requests.
   * Defaults to true for localhost/IP endpoints and false otherwise.
   */
  readonly pathStyle?: boolean
  /** Key prefix that contains the blobs/sha256 object layout. Defaults to "sixb". */
  readonly basePath?: string
  /** Part size and small-object threshold for streamed `put(...)` calls. Defaults to 8 MiB. */
  readonly putPartSizeBytes?: number
  /** Maximum parallel multipart parts per streamed `put(...)`. Defaults to 2. */
  readonly putConcurrency?: number
  /** Retry attempts for replayable AWS SDK requests. Defaults to 3. */
  readonly putRetries?: number
}
