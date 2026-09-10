/**
 * Error for lake-storage invariants and invalid lake operations.
 */
export class LakeStorageError extends Error {
  readonly name: string = "LakeStorageError"
}

/** A known, uncommitted version/transaction conflict; safe to retry staged changes. */
export class LakeConcurrencyError extends LakeStorageError {
  override readonly name = "LakeConcurrencyError"
}
