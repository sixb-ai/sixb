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
 * The five coarse kinds, for the caller who wants the class of failure without enumerating its
 * codes: `if (sixbErrorKind(error) === "conflict") return retryAfterReread()`.
 *
 * Each kind owns a closed set of codes, so it means something precise rather than reading as a mood.
 * A code may belong to no kind; it may not belong to two.
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

/** The caller is not allowed to do this, or is not who they claim to be. */
export const SIXB_AUTHORIZATION_ERROR_CODES = [
  "auth.authentication_required",
  "auth.invalid_credentials",
  "auth.origin_rejected",
  "auth.permission_denied",
  "auth.session_expired",
] as const satisfies readonly SixbErrorCode[]

/** The state moved underneath the caller. Re-read, then retry or reconcile. */
export const SIXB_CONFLICT_ERROR_CODES = [
  "agent.run_conflict",
  "agent.thread_conflict",
  "pipeline.already_running",
  "queue.lease_lost",
  "storage.conflict",
  "storage.upload_conflict",
  "sync.already_running",
  "workflow.run_conflict",
] as const satisfies readonly SixbErrorCode[]

/** A bound was exceeded and the work was abandoned mid-flight. */
export const SIXB_TIMEOUT_ERROR_CODES = [
  "action.timed_out",
  "agent.timed_out",
  "sandbox.timed_out",
] as const satisfies readonly SixbErrorCode[]

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

/**
 * Exactly what {@link isSixbError} verified, and no more.
 *
 * Narrower than {@link SixbError} on purpose: the guard exists to recognize a failure that came out
 * of another copy of the runtime, a run row, or the client, and none of those carries `retryable` —
 * that field only ever lives on the thrown class. Narrowing to the class instead promised a
 * `boolean` that is `undefined` at runtime on the very path the guard was written for, and
 * `undefined === false` reads as *retryable*, which is the wrong way to fail. A caller that holds a
 * live `SixbError` still reads `.retryable` off it directly.
 *
 * No `details` either, and that is the same rule applied once more. The guard does not look at it,
 * and it should not: `details` is a flat scalar bag, so validating it would mean rejecting a whole
 * failure over one bad key — where {@link toSixbFailure} keeps the good keys and drops the rest.
 * Read it through that function, which is the one that sanitizes.
 */
export interface SixbErrorLike {
  readonly code: SixbErrorCode
  readonly message: string
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
 * it keeps the guard honest: it never claims to recognize a code it cannot also branch on. The
 * narrowed type is {@link SixbErrorLike} for the same reason.
 */
export function isSixbError(value: unknown, code?: SixbErrorCode): value is SixbErrorLike {
  if (value instanceof SixbError) {
    return code === undefined || value.code === code
  }

  if (typeof value !== "object" || value === null) return false
  const candidate = value as { readonly message?: unknown; readonly code?: unknown }
  if (typeof candidate.message !== "string") return false
  if (!isSixbErrorCode(candidate.code)) return false
  return code === undefined || candidate.code === code
}

/** The coarse class of a failure, for a caller who does not want to enumerate codes. */
export type SixbErrorKind = "validation" | "authorization" | "conflict" | "timeout" | "provider"

const KIND_BY_CODE: Partial<Record<SixbErrorCode, SixbErrorKind>> = {
  ...codeKinds(SIXB_VALIDATION_ERROR_CODES, "validation"),
  ...codeKinds(SIXB_AUTHORIZATION_ERROR_CODES, "authorization"),
  ...codeKinds(SIXB_CONFLICT_ERROR_CODES, "conflict"),
  ...codeKinds(SIXB_TIMEOUT_ERROR_CODES, "timeout"),
  ...codeKinds(SIXB_PROVIDER_ERROR_CODES, "provider"),
}

function codeKinds(
  codes: readonly SixbErrorCode[],
  kind: SixbErrorKind
): Partial<Record<SixbErrorCode, SixbErrorKind>> {
  return Object.fromEntries(codes.map((code) => [code, kind]))
}

/**
 * Groups a failure into one of the five coarse kinds, or `undefined` for a code that belongs to none.
 *
 * This is the answer to "is this a conflict?" without listing the five conflict codes, and it works
 * where the class hierarchy it replaces could not: the kind is derived from `code`, so it survives a
 * failure that crossed a bundle boundary between two copies of the runtime.
 */
export function sixbErrorKind(error: unknown): SixbErrorKind | undefined {
  return isSixbError(error) ? KIND_BY_CODE[error.code] : undefined
}
