import { type SixbErrorOptions, SixbProviderError } from "../errors"

/**
 * Error for lake-storage invariants and invalid lake operations.
 */
export class LakeStorageError extends SixbProviderError {
  override readonly name = "LakeStorageError"

  constructor(message: string, options?: SixbErrorOptions) {
    super("storage.lake_failed", message, options)
  }
}
