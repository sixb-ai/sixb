import type { TokenCredential } from "@azure/core-auth"

export interface AzureBlobStorageOptions {
  /** Existing container. The provider does not provision infrastructure. */
  readonly container: string
  /** Storage account name, used to construct the standard Azure service URL. */
  readonly accountName?: string
  /** Explicit Blob service URL. Mutually exclusive with accountName. */
  readonly serviceUrl?: string
  /** Defaults to DefaultAzureCredential when using accountName or serviceUrl. */
  readonly credential?: TokenCredential
  /** Shared-key connection string, including Azurite's UseDevelopmentStorage=true. */
  readonly connectionString?: string
  /** Prefix for blobs/sha256 and uploads. Defaults to "sixb". */
  readonly basePath?: string
  /** Buffered upload block size. Defaults to 8 MiB; maximum 100 MiB. */
  readonly blockSizeBytes?: number
  /** Maximum concurrent block uploads. Defaults to 2. */
  readonly concurrency?: number
  /** Retries per Azure request, in addition to the first attempt. Defaults to 3. */
  readonly retries?: number
  /** Maximum browser upload. Defaults to 512 MiB; bounded by 50,000 blocks. */
  readonly directUploadMaxSizeBytes?: number
  /** Use multipart above this size. Defaults to 32 MiB; maximum 5,000 MiB. */
  readonly multipartThresholdBytes?: number
  /** Maximum active completions per provider instance. Defaults to 2. Excess calls can retry. */
  readonly completionConcurrency?: number
  /** Deadline for verification and publication of one direct upload. Defaults to 5 minutes. */
  readonly completionTimeoutMillis?: number
}
