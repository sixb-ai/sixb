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

/**
 * The lake cannot hold a value of a change it stages, such as a decimal past its precision or a
 * timestamp outside its range, although the value is valid for the dataset's schema. The change
 * is at fault, not the lake: a provider throws this only when it refuses the value itself, never
 * for its own state or availability.
 */
export class LakeValueRefusedError extends LakeStorageError {
  override readonly name = "LakeValueRefusedError"
}
