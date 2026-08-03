import {
  isSixbError,
  SixbError,
  type SixbErrorOptions,
  sixbFailureReason,
  toSixbFailure,
} from "../errors"

/** The object a lookup or a write could not find. */
export interface MissingObjectRef {
  readonly objectTypeId: string
  readonly primaryId: string
}

/**
 * A storage lookup by primary ID found no matching object.
 *
 * `context` names the operation that went looking; the reference itself goes into `details` so a
 * caller can act on it without parsing the message. Read it back with {@link missingObjectRef}.
 */
export function objectNotFound(
  objectTypeId: string,
  primaryId: string,
  context: string
): SixbError {
  return new SixbError(
    "storage.object_not_found",
    `[Sixb] ${context}: ${objectTypeId}:${primaryId}`,
    { details: { objectTypeId, primaryId } }
  )
}

/** The object reference this failure names, or `undefined` when it is not a missing-object failure. */
export function missingObjectRef(error: unknown): MissingObjectRef | undefined {
  if (!isSixbError(error, "storage.object_not_found")) return undefined
  const { objectTypeId, primaryId } = toSixbFailure(error).details ?? {}
  if (typeof objectTypeId !== "string" || typeof primaryId !== "string") return undefined
  return { objectTypeId, primaryId }
}

const STORAGE_TRANSACTION_ERROR_REASONS = [
  "nested_transaction",
  "serialization_failure",
  "transaction_inactive",
] as const

export type StorageTransactionErrorReason = (typeof STORAGE_TRANSACTION_ERROR_REASONS)[number]

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
export function storageTransactionError(
  message: string,
  options: StorageTransactionErrorOptions = {}
): SixbError {
  const { reason, ...rest } = options
  return new SixbError(
    reason === "serialization_failure" ? "storage.conflict" : "storage.transaction_failed",
    message,
    reason ? { ...rest, details: { reason, ...rest.details } } : rest
  )
}

/** Whether this failure is a lost serialization race, which the caller retries as-is. */
export function isStorageSerializationFailure(error: unknown): boolean {
  return sixbFailureReason(error, STORAGE_TRANSACTION_ERROR_REASONS) === "serialization_failure"
}
