import { type SixbErrorOptions, SixbProviderError } from "../errors"

/**
 * Error for blob storage invariants and provider-level failures.
 */
export class BlobStorageError extends SixbProviderError {
  override readonly name = "BlobStorageError"

  constructor(message: string, options?: SixbErrorOptions) {
    super("storage.blob_failed", message, options)
  }
}
