/**
 * Thrown when a storage lookup by primary ID finds no matching object.
 * Carries structured context so callers can discriminate without string parsing.
 */
export class ObjectNotFoundError extends Error {
  readonly name = "ObjectNotFoundError"

  constructor(
    readonly objectTypeId: string,
    readonly primaryId: string,
    readonly context: string
  ) {
    super(`[Sixb] ${context}: ${objectTypeId}:${primaryId}`)
  }
}

export class ObjectStorageError extends Error {
  readonly name = "ObjectStorageError"
}

export type StorageTransactionErrorCode =
  | "nested_transaction"
  | "serialization_failure"
  | "transaction_inactive"

export interface StorageTransactionErrorOptions {
  readonly cause?: unknown
  readonly code?: StorageTransactionErrorCode
}

export class StorageTransactionError extends Error {
  readonly name = "StorageTransactionError"
  readonly code?: StorageTransactionErrorCode
  override readonly cause?: unknown

  constructor(message: string, options: StorageTransactionErrorOptions = {}) {
    super(message)
    this.code = options.code
    this.cause = options.cause
  }
}

export function isStorageSerializationFailure(error: unknown): boolean {
  return error instanceof StorageTransactionError && error.code === "serialization_failure"
}
