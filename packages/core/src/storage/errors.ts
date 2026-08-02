import { SixbError, type SixbErrorOptions } from "../errors"

/**
 * Thrown when a storage lookup by primary ID finds no matching object.
 * Carries structured context so callers can discriminate without string parsing.
 */
export class ObjectNotFoundError extends SixbError {
  override readonly name = "ObjectNotFoundError"

  constructor(
    readonly objectTypeId: string,
    readonly primaryId: string,
    readonly context: string
  ) {
    super("storage.object_not_found", `[Sixb] ${context}: ${objectTypeId}:${primaryId}`, {
      details: { objectTypeId, primaryId },
    })
  }
}

export type StorageTransactionErrorReason =
  | "nested_transaction"
  | "serialization_failure"
  | "transaction_inactive"

export interface StorageTransactionErrorOptions extends SixbErrorOptions {
  readonly reason?: StorageTransactionErrorReason
}

/**
 * A transaction could not be used as asked.
 *
 * The two failure modes are unrelated and are filed apart: losing a serialization race is a
 * `storage.conflict` the caller retries, while nesting a transaction or using a closed one is a
 * `storage.transaction_failed` that will fail the same way forever.
 */
export class StorageTransactionError extends SixbError {
  override readonly name = "StorageTransactionError"
  readonly reason?: StorageTransactionErrorReason

  constructor(message: string, options: StorageTransactionErrorOptions = {}) {
    super(
      options.reason === "serialization_failure"
        ? "storage.conflict"
        : "storage.transaction_failed",
      message,
      options.reason
        ? { ...options, details: { reason: options.reason, ...options.details } }
        : options
    )
    this.reason = options.reason
  }
}

export function isStorageSerializationFailure(error: unknown): boolean {
  return error instanceof StorageTransactionError && error.reason === "serialization_failure"
}
