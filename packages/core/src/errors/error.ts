import { isSixbErrorCode, SIXB_ERROR_RETRYABLE, type SixbErrorCode } from "./codes"
import type { SixbFailureDetails } from "./failure"

export interface SixbErrorOptions {
  /**
   * Overrides {@link SIXB_ERROR_RETRYABLE} for this one failure. Set it when the call site knows
   * something the code cannot — a provider that answered `Retry-After`, a conflict on a key that
   * will never be free.
   */
  readonly retryable?: boolean
  /**
   * Context for whoever reads the failure later: the object type, the provider name, the field
   * that failed. Written into the run row and onto the wire as-is, so it must not carry anything
   * secret.
   */
  readonly details?: SixbFailureDetails
  /** The error this one wraps. Never dropped — {@link toSixbFailure} renders it. */
  readonly cause?: unknown
}

/**
 * Every failure Sixb raises on purpose.
 *
 * The class is deliberately thin: a {@link SixbErrorCode}, a retry verdict, an optional JSON bag,
 * and the wrapped cause. Everything a consumer branches on is data, which is what lets the same
 * failure cross a database column, an HTTP response, and a bundle boundary without turning back
 * into a string.
 *
 * Message text is not part of the contract. Nothing should parse it, and it may be reworded in a
 * patch release; branch on {@link SixbError.code} instead.
 */
export class SixbError extends Error {
  override readonly name: string = "SixbError"
  readonly code: SixbErrorCode
  readonly retryable: boolean
  readonly details?: SixbFailureDetails

  constructor(code: SixbErrorCode, message: string, options: SixbErrorOptions = {}) {
    // Only pass `cause` through when there is one: `{ cause: undefined }` still installs the own
    // property, which makes an error look wrapped when it is not.
    super(message, "cause" in options ? { cause: options.cause } : undefined)
    this.code = code
    this.retryable = options.retryable ?? SIXB_ERROR_RETRYABLE[code]
    if (options.details) this.details = options.details
  }
}

/**
 * The five coarse buckets, kept because a caller often wants the class of failure without
 * enumerating its codes: `catch (error) { if (error instanceof SixbConflictError) return retry() }`.
 *
 * Each one owns a closed set of codes, so the bucket means something precise rather than reading as
 * a mood. A code may belong to no bucket; it may not belong to two.
 */

/** The input is wrong and nothing was written. Maps to 4xx, never worth retrying unchanged. */
export const SIXB_VALIDATION_ERROR_CODES = [
  "ontology.invalid_value",
  "ontology.type_not_found",
  "runtime.invalid_definition",
  "runtime.invalid_input",
  "runtime.payload_too_large",
  "storage.edit_rejected",
  "storage.query_invalid",
] as const satisfies readonly SixbErrorCode[]

export type SixbValidationErrorCode = (typeof SIXB_VALIDATION_ERROR_CODES)[number]

export class SixbValidationError extends SixbError {
  override readonly name: string = "SixbValidationError"

  // biome-ignore lint/complexity/noUselessConstructor: it narrows `code` to this class's set.
  constructor(code: SixbValidationErrorCode, message: string, options?: SixbErrorOptions) {
    super(code, message, options)
  }
}

/** The caller is not allowed to do this, or is not who they claim to be. */
export const SIXB_AUTHORIZATION_ERROR_CODES = [
  "auth.authentication_required",
  "auth.invalid_credentials",
  "auth.origin_rejected",
  "auth.permission_denied",
  "auth.session_expired",
] as const satisfies readonly SixbErrorCode[]

export type SixbAuthorizationErrorCode = (typeof SIXB_AUTHORIZATION_ERROR_CODES)[number]

export class SixbAuthorizationError extends SixbError {
  override readonly name: string = "SixbAuthorizationError"

  // biome-ignore lint/complexity/noUselessConstructor: it narrows `code` to this class's set.
  constructor(code: SixbAuthorizationErrorCode, message: string, options?: SixbErrorOptions) {
    super(code, message, options)
  }
}

/** The state moved underneath the caller. Re-read, then retry or reconcile. */
export const SIXB_CONFLICT_ERROR_CODES = [
  "agent.run_conflict",
  "pipeline.already_running",
  "queue.lease_lost",
  "storage.conflict",
  "sync.already_running",
] as const satisfies readonly SixbErrorCode[]

export type SixbConflictErrorCode = (typeof SIXB_CONFLICT_ERROR_CODES)[number]

export class SixbConflictError extends SixbError {
  override readonly name: string = "SixbConflictError"

  // biome-ignore lint/complexity/noUselessConstructor: it narrows `code` to this class's set.
  constructor(code: SixbConflictErrorCode, message: string, options?: SixbErrorOptions) {
    super(code, message, options)
  }
}

/** A bound was exceeded and the work was abandoned mid-flight. */
export const SIXB_TIMEOUT_ERROR_CODES = [
  "action.timed_out",
  "agent.timed_out",
  "sandbox.timed_out",
] as const satisfies readonly SixbErrorCode[]

export type SixbTimeoutErrorCode = (typeof SIXB_TIMEOUT_ERROR_CODES)[number]

export class SixbTimeoutError extends SixbError {
  override readonly name: string = "SixbTimeoutError"

  // biome-ignore lint/complexity/noUselessConstructor: it narrows `code` to this class's set.
  constructor(code: SixbTimeoutErrorCode, message: string, options?: SixbErrorOptions) {
    super(code, message, options)
  }
}

/** Something Sixb does not own failed: a database, a queue, a broker, a third-party API. */
export const SIXB_PROVIDER_ERROR_CODES = [
  "broker.unavailable",
  "connector.rate_limited",
  "connector.request_failed",
  "connector.unauthorized",
  "connector.unavailable",
  "provider.failed",
  "provider.unavailable",
  "queue.unavailable",
  "storage.blob_failed",
  "storage.lake_failed",
  "storage.unavailable",
] as const satisfies readonly SixbErrorCode[]

export type SixbProviderErrorCode = (typeof SIXB_PROVIDER_ERROR_CODES)[number]

export class SixbProviderError extends SixbError {
  override readonly name: string = "SixbProviderError"

  // biome-ignore lint/complexity/noUselessConstructor: it narrows `code` to this class's set.
  constructor(code: SixbProviderErrorCode, message: string, options?: SixbErrorOptions) {
    super(code, message, options)
  }
}

/**
 * Identifies a Sixb error across bundle boundaries, optionally narrowing to one code.
 *
 * Structural, for the same reason `isSixbApiError` is: a custom app, the client, and the server
 * are bundled separately, so `instanceof` misses an error that crossed packages. The `instanceof`
 * check stays first because it is both cheaper and exact.
 *
 * The fallback recognizes a *known* code rather than a name pattern. That is the stronger signal —
 * a name can be anything, while `SIXB_ERROR_CODES` is the vocabulary this build understands — and
 * it keeps the guard honest: it never claims to recognize a code it cannot also branch on.
 */
export function isSixbError(value: unknown, code?: SixbErrorCode): value is SixbError {
  if (value instanceof SixbError) {
    return code === undefined || value.code === code
  }

  if (typeof value !== "object" || value === null) return false
  const candidate = value as { readonly message?: unknown; readonly code?: unknown }
  if (typeof candidate.message !== "string") return false
  if (!isSixbErrorCode(candidate.code)) return false
  return code === undefined || candidate.code === code
}
