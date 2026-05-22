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
  /** S3 bucket name. When omitted, Bun can read S3_BUCKET from the environment. */
  readonly bucket?: string
  /** AWS region. For non-AWS providers, use endpoint instead. */
  readonly region?: string
  /** S3-compatible endpoint such as an R2, Spaces, or MinIO URL. */
  readonly endpoint?: string
  /** Access key id. When omitted, Bun can read S3_ACCESS_KEY_ID or AWS_ACCESS_KEY_ID. */
  readonly accessKeyId?: string
  /** Secret access key. When omitted, Bun can read S3_SECRET_ACCESS_KEY or AWS_SECRET_ACCESS_KEY. */
  readonly secretAccessKey?: string
  /** Optional session token for temporary credentials. */
  readonly sessionToken?: string
  /** Optional ACL forwarded to Bun's S3Client. */
  readonly acl?: S3BlobStorageAcl
  /** Key prefix that contains the blobs/sha256 object layout. Defaults to "pario". */
  readonly basePath?: string
}
