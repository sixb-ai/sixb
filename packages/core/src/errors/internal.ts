import { cloneJsonValue, type ReadonlyJsonValue } from "../json"
import { SIXB_ERROR_DEFINITIONS } from "./catalog"
import type { SixbErrorCode, SixbFailure } from "./types"

export const SIXB_FAILURE_MAX_MESSAGE_BYTES = 4 * 1024
export const SIXB_FAILURE_MAX_SERIALIZED_BYTES = 32 * 1024
const TRUNCATION_SUFFIX = "… [truncated]"

type SixbErrorCodeTuple = readonly [SixbErrorCode, ...SixbErrorCode[]]

export interface SixbErrorOptions {
  readonly cause?: unknown
  readonly details?: ReadonlyJsonValue
}

/** Internal structural view returned by the factory. The implementing class stays private. */
export interface SixbCodedError extends Error {
  readonly code: SixbErrorCode
  readonly retryable: boolean
  readonly details?: ReadonlyJsonValue
  readonly cause?: unknown
}

export interface ToSixbFailureOptions {
  /** Timestamp for deterministic persistence. Defaults to the current time. */
  readonly at?: Date
}

export interface ToScopedSixbFailureOptions<TCodes extends SixbErrorCodeTuple>
  extends ToSixbFailureOptions {
  /** Codes this boundary is allowed to expose. */
  readonly allowedCodes: TCodes
}

export interface CaptureSixbFailureOptions<TCodes extends SixbErrorCodeTuple>
  extends ToScopedSixbFailureOptions<TCodes> {
  /** Code assigned when the captured value is uncoded or outside this boundary's contract. */
  readonly defaultCode: TCodes[number]
  /** Context attached only to the boundary error created for such a captured value. */
  readonly details?: ReadonlyJsonValue
}

/**
 * The canonical exception used inside Sixb.
 *
 * The class is deliberately not exported: repo-internal callers use the factory and consumers only
 * ever observe serializable `SixbFailure` values.
 */
class SixbError extends Error implements SixbCodedError {
  override readonly name = "SixbError"
  readonly retryable: boolean
  readonly details?: ReadonlyJsonValue

  constructor(
    readonly code: SixbErrorCode,
    message: string,
    options: SixbErrorOptions = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.retryable = SIXB_ERROR_DEFINITIONS[code].retryable
    if (options.details !== undefined) {
      this.details = cloneJsonValue(options.details, "Sixb error details")
    }
  }
}

/** Creates a coded internal error without exposing its runtime class. */
export function createSixbError(
  code: SixbErrorCode,
  message: string,
  options: SixbErrorOptions = {}
): SixbCodedError {
  return new SixbError(code, message, options)
}

/**
 * Captures an unknown terminal error as a scoped durable failure.
 *
 * An already-coded error is preserved only when its code belongs to this boundary. Every other
 * value is wrapped once with the boundary's default code and context before serialization.
 */
export function captureSixbFailure<const TCodes extends SixbErrorCodeTuple>(
  error: unknown,
  options: CaptureSixbFailureOptions<TCodes>
): SixbFailure<TCodes[number]> {
  const allowedCodes = new Set<SixbErrorCode>(options.allowedCodes)
  const codedError =
    isSixbError(error) && allowedCodes.has(error.code)
      ? error
      : createSixbError(options.defaultCode, summarizeErrorMessage(error), {
          cause: error,
          ...(options.details === undefined ? {} : { details: options.details }),
        })

  return toSixbFailure(codedError, {
    allowedCodes: options.allowedCodes,
    ...(options.at === undefined ? {} : { at: options.at }),
  })
}

/** Identifies errors created by Sixb without making their class part of the contract. */
export function isSixbError(error: unknown): error is SixbCodedError {
  return error instanceof SixbError
}

/**
 * Takes a detached, serializable snapshot of a coded internal error.
 *
 * Use `captureSixbFailure()` instead when a terminal boundary receives an unknown thrown value.
 */
export function toSixbFailure<const TCodes extends SixbErrorCodeTuple>(
  error: SixbCodedError,
  options: ToScopedSixbFailureOptions<TCodes>
): SixbFailure<TCodes[number]>
export function toSixbFailure(error: SixbCodedError, options?: ToSixbFailureOptions): SixbFailure
export function toSixbFailure(
  error: SixbCodedError,
  options: ToSixbFailureOptions | ToScopedSixbFailureOptions<SixbErrorCodeTuple> = {}
): SixbFailure {
  if (!isSixbError(error)) {
    throw new Error("[Sixb] A durable failure can only be created from a coded Sixb error.")
  }
  const allowedCodes = "allowedCodes" in options ? new Set(options.allowedCodes) : undefined
  if (allowedCodes && !allowedCodes.has(error.code)) {
    throw new Error(`[Sixb] Error code '${error.code}' is not allowed by this failure contract.`)
  }

  const message = truncateUtf8(
    SIXB_ERROR_DEFINITIONS[error.code].publicMessage,
    SIXB_FAILURE_MAX_MESSAGE_BYTES
  )
  const failure: SixbFailure = {
    code: error.code,
    message: message.value,
    retryable: SIXB_ERROR_DEFINITIONS[error.code].retryable,
    at: failureTimestamp(options.at),
    ...(error.details === undefined
      ? {}
      : { details: cloneJsonValue(error.details, "Sixb failure details") }),
    ...(message.truncated ? { truncated: true } : {}),
  }

  if (serializedByteLength(failure) <= SIXB_FAILURE_MAX_SERIALIZED_BYTES) return failure

  return {
    code: failure.code,
    message: failure.message,
    retryable: failure.retryable,
    at: failure.at,
    truncated: true,
  }
}

/**
 * Extracts a diagnostic message for an internal error or log entry.
 *
 * The result can contain provider data and must not be persisted or returned by an API.
 * `toSixbFailure()` selects the catalog-owned public message instead.
 */
export function summarizeErrorMessage(value: unknown, fallback?: string): string {
  const message = readStringProperty(value, "message")
  if (message !== undefined) return message
  if (typeof value === "string") return value
  return fallback ?? safeString(value)
}

function readStringProperty(value: unknown, property: "message"): string | undefined {
  if (!isObjectLike(value)) return undefined
  try {
    const result = Reflect.get(value, property)
    return typeof result === "string" ? result : undefined
  } catch {
    return undefined
  }
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function"
}

function safeString(value: unknown): string {
  try {
    return String(value)
  } catch {
    return "Unknown thrown value"
  }
}

function failureTimestamp(at: Date | undefined): string {
  const timestamp = at ?? new Date()
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error("[Sixb] Failure timestamp must be a valid Date.")
  }
  return timestamp.toISOString()
}

function serializedByteLength(value: SixbFailure): number {
  return utf8ByteLength(JSON.stringify(value))
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (utf8ByteLength(value) <= maxBytes) return { value, truncated: false }

  const suffixBytes = utf8ByteLength(TRUNCATION_SUFFIX)
  const characters = Array.from(value)
  let low = 0
  let high = characters.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (utf8ByteLength(characters.slice(0, middle).join("")) + suffixBytes <= maxBytes) {
      low = middle
    } else {
      high = middle - 1
    }
  }

  return { value: `${characters.slice(0, low).join("")}${TRUNCATION_SUFFIX}`, truncated: true }
}
