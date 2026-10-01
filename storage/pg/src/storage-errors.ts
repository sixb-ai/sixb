import { createSixbError } from "@sixb/core/internal/errors"

// Map thrown errors to their PostgreSQL/porsager meaning by code rather than by matching
// message text. Database errors arrive in the native Postgres format with a SQLSTATE on
// `.code` and the server's `severity`; connection-layer failures arrive with porsager's own
// codes or the socket's system error code.

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

/**
 * Codes that mean the connection itself is gone, not that a statement failed: porsager's own codes
 * for a connection that closed under a query or that the pool destroyed, and the socket errors a
 * live connection can die with. Connect-time failures (`ECONNREFUSED`, `CONNECT_TIMEOUT`, ...) are
 * left out on purpose: they reject before any session exists, so there is nothing to give up.
 */
const CONNECTION_LOST_CODES = new Set([
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
])

/**
 * Codes of a connection that could not be opened: refused, unresolvable, unreachable, or not
 * answered in time. A server that accepts the socket and then refuses the session (too many
 * connections, starting up) answers with a `FATAL` error, which `isConnectionLost` covers.
 */
const CONNECT_FAILED_CODES = new Set([
  "CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
])

/**
 * The shared lock tables PostgreSQL can fill, keyed by the setting its hint names. Both raise
 * SQLSTATE 53200 (`out_of_memory`) with the message "out of shared memory", which reads like the
 * server ran out of RAM; the hint is the only part that says which table filled up.
 */
const LOCK_TABLES = [
  {
    setting: "max_pred_locks_per_transaction",
    table: "predicate lock table",
    note:
      " A long serializable transaction also keeps the predicate locks of every serializable" +
      " transaction that commits while it is open.",
  },
  { setting: "max_locks_per_transaction", table: "lock table", note: "" },
] as const

const OUT_OF_MEMORY = "53200"

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
 * True when the error means the session is gone: PostgreSQL has already rolled back its open
 * transaction and released its locks, and nothing more may be sent on that connection.
 *
 * PostgreSQL ends the session after every `FATAL` or `PANIC` error — `pg_terminate_backend` (57P01),
 * a server shutdown (57P02), `idle_in_transaction_session_timeout` (25P03) — so the severity decides
 * rather than a list of SQLSTATEs.
 */
export function isConnectionLost(error: unknown): boolean {
  const code = pgErrorCode(error)
  if (code !== undefined && CONNECTION_LOST_CODES.has(code)) {
    return true
  }
  const severity =
    error instanceof Error ? (error as { readonly severity?: unknown }).severity : null
  return severity === "FATAL" || severity === "PANIC"
}

/**
 * Replace an error that says something about the database rather than the statement: a lost or
 * unopenable connection becomes the retryable `storage.unavailable`, a full lock table an error
 * naming the table and the setting that sizes it. Every other error is returned unchanged.
 */
export function explainPgError(error: unknown): unknown {
  if (isStorageUnavailable(error)) {
    return storageUnavailable(error)
  }
  if (!(error instanceof Error) || pgErrorCode(error) !== OUT_OF_MEMORY) {
    return error
  }
  const hint = (error as { readonly hint?: unknown }).hint
  const lockTable =
    typeof hint === "string" ? LOCK_TABLES.find(({ setting }) => hint.includes(setting)) : undefined
  if (!lockTable) {
    return error
  }

  const { setting, table, note } = lockTable
  return new Error(
    `[SixbPg] PostgreSQL aborted the transaction because its shared ${table} is full ` +
      `(SQLSTATE 53200 "${error.message}"). The table holds ${setting} × (max_connections + ` +
      `max_prepared_transactions) entries shared by all sessions.${note} Raise ${setting} ` +
      "(applied at server restart) or shorten the transactions that overlap.",
    { cause: error }
  )
}

function isStorageUnavailable(error: unknown): boolean {
  const code = pgErrorCode(error)
  return isConnectionLost(error) || (code !== undefined && CONNECT_FAILED_CODES.has(code))
}

/**
 * Whether a lost connection's transaction committed is unknown when the loss interrupted its
 * COMMIT, so the message does not say it rolled back. Retrying is still safe for Sixb's own
 * writes: each is fenced or idempotent.
 */
function storageUnavailable(error: unknown): Error {
  const code = pgErrorCode(error)
  const reason = error instanceof Error ? error.message : String(error)
  return createSixbError(
    "storage.unavailable",
    `[SixbPg] PostgreSQL is unavailable: the connection was lost or could not be opened (${code ?? "no code"}: ${reason}).`,
    { cause: error, ...(code === undefined ? {} : { details: { code } }) }
  )
}
