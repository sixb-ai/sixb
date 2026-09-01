export type AiLimitStorageErrorCode =
  | "duplicate_policy"
  | "missing_policy"
  | "missing_execution"
  | "missing_reservation"
  | "missing_usage_record"
  | "usage_mismatch"
  | "unavailable_actuals"
  | "reservation_conflict"
  | "reconciliation_conflict"
  | "invalid_reservation_state"

/** Stable storage failure for AI limit policies and reservations. */
export class AiLimitStorageError extends Error {
  readonly name = "AiLimitStorageError"

  constructor(
    readonly code: AiLimitStorageErrorCode,
    message: string
  ) {
    super(message)
  }
}
