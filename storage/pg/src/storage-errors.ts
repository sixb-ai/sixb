// Map thrown errors to their PostgreSQL/porsager meaning by code rather than by matching
// message text. Database errors arrive in the native Postgres format with a SQLSTATE on
// `.code`; connection-layer failures arrive with porsager's own codes or, for Node socket
// errors, as an `AggregateError` of `ECONNREFUSED`/`ETIMEDOUT`/… entries.

/** PostgreSQL SQLSTATE for a unique-constraint violation. */
const UNIQUE_VIOLATION = "23505"

/** PostgreSQL SQLSTATE for a serializable transaction conflict. */
const SERIALIZATION_FAILURE = "40001"

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

/** True when the error is a PostgreSQL serialization failure (SQLSTATE 40001). */
export function isSerializationFailure(error: unknown): boolean {
  return pgErrorCode(error) === SERIALIZATION_FAILURE
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
