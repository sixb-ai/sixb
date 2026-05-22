/**
 * Error for blob storage invariants and provider-level failures.
 */
export class BlobStorageError extends Error {
  readonly name = "BlobStorageError"
}
