// Map thrown errors to their PostgreSQL/porsager meaning by code rather than by matching
// message text. Database errors arrive in the native Postgres format with a SQLSTATE on
// `.code`; connection-layer failures arrive with porsager's own codes or, for Node socket
// errors, as an `AggregateError` of `ECONNREFUSED`/`ETIMEDOUT`/… entries.

/** PostgreSQL SQLSTATE for a unique-constraint violation. */
const UNIQUE_VIOLATION = "23505"
const FOREIGN_KEY_VIOLATION = "23503"

/**
 * PostgreSQL SQLSTATEs in class 40 (transaction rollback) that are transient and safe to retry by
 * replaying the whole transaction: `40001` (serialization_failure) and `40P01` (deadlock_detected).
 * Under `SERIALIZABLE` the server raises *either* — a serialization anomaly surfaces as `40001`,
 * while two transactions taking row locks in crossing order surface as `40P01` — and both clear on
 * a fresh attempt. The other class-40 codes (`40002` integrity-constraint violation, `40003`
 * statement-completion unknown) are deliberately excluded: they are not safe to blindly replay.
 */
const RETRYABLE_TRANSACTION_CONFLICT_CODES = new Set(["40001", "40P01"])

const CONNECTION_ERROR_CODES = new Set([
  // porsager-specific
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
  "CONNECTION_ENDED",
  // Node socket errors
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
])

/** The SQLSTATE / system error code carried by a thrown database or connection error. */
export function pgErrorCode(error: unknown): string | undefined {
  if (error instanceof Error) {
    const code = (error as { readonly code?: unknown }).code
    if (typeof code === "string") {
      return code
    }
  }
  return undefined
}

/** True when the error is a PostgreSQL unique-constraint violation (SQLSTATE 23505). */
export function isUniqueViolation(error: unknown): boolean {
  return pgErrorCode(error) === UNIQUE_VIOLATION
}

/** True when the error is a PostgreSQL foreign-key violation (SQLSTATE 23503). */
export function isForeignKeyViolation(error: unknown): boolean {
  return pgErrorCode(error) === FOREIGN_KEY_VIOLATION
}

/**
 * True when the error is a transient transaction-rollback conflict that is safe to retry by
 * replaying the transaction — a serialization failure (SQLSTATE 40001) or a deadlock (40P01).
 * See {@link RETRYABLE_TRANSACTION_CONFLICT_CODES}.
 */
export function isRetryableTransactionConflict(error: unknown): boolean {
  const code = pgErrorCode(error)
  return code !== undefined && RETRYABLE_TRANSACTION_CONFLICT_CODES.has(code)
}

/**
 * True when the error originates from the connection layer (porsager connection codes, or a
 * Node socket failure surfaced as an `AggregateError`) rather than from a SQL statement.
 */
export function isConnectionError(error: unknown): boolean {
  const code = pgErrorCode(error)
  if (code !== undefined && CONNECTION_ERROR_CODES.has(code)) {
    return true
  }
  if (error instanceof AggregateError) {
    return error.errors.some(isConnectionError)
  }
  return false
}
