import { cloneJsonValue, isJsonValue, isPlainRecord, type ReadonlyJsonValue } from "../json"
import { SIXB_ERROR_CODES, SIXB_ERROR_DEFINITIONS } from "./catalog"
import type { SixbErrorCode, SixbFailure } from "./types"

export const SIXB_FAILURE_MAX_MESSAGE_BYTES = 4 * 1024
export const SIXB_FAILURE_MAX_SERIALIZED_BYTES = 32 * 1024
const TRUNCATION_SUFFIX = "… [truncated]"
const SIXB_ERROR_CODE_SET: ReadonlySet<string> = new Set(SIXB_ERROR_CODES)

type SixbErrorCodeTuple = readonly [SixbErrorCode, ...SixbErrorCode[]]

export { SIXB_ERROR_CODES }

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
  const code = error.code
  const details = error.details
  const message = truncateUtf8(
    SIXB_ERROR_DEFINITIONS[code].publicMessage,
    SIXB_FAILURE_MAX_MESSAGE_BYTES
  )
  const failure: SixbFailure = {
    code,
    message: message.value,
    retryable: SIXB_ERROR_DEFINITIONS[code].retryable,
    at: failureTimestamp(options.at),
    ...(details === undefined ? {} : { details: cloneJsonValue(details, "Sixb failure details") }),
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

/** Serializes a validated failure for durable storage. */
export function serializeSixbFailure<const TCodes extends SixbErrorCodeTuple>(
  failure: SixbFailure<TCodes[number]>,
  allowedCodes: TCodes
): string
export function serializeSixbFailure(failure: SixbFailure): string
export function serializeSixbFailure(
  failure: SixbFailure,
  allowedCodes?: SixbErrorCodeTuple
): string {
  const parsed = allowedCodes ? parseSixbFailure(failure, allowedCodes) : parseSixbFailure(failure)
  return JSON.stringify(parsed)
}

/**
 * Validates and detaches a failure read from a storage boundary.
 *
 * Strings are accepted for SQLite; PostgreSQL adapters can pass their decoded JSON value directly.
 */
export function parseSixbFailure<const TCodes extends SixbErrorCodeTuple>(
  value: unknown,
  allowedCodes: TCodes
): SixbFailure<TCodes[number]>
export function parseSixbFailure(value: unknown): SixbFailure
export function parseSixbFailure(
  value: unknown,
  allowedCodes: SixbErrorCodeTuple = SIXB_ERROR_CODES
): SixbFailure {
  const candidate = parseStoredFailureValue(value)
  if (!isPlainRecord(candidate)) {
    throw invalidStoredFailure("expected a JSON object")
  }

  const { code, message, retryable, at, details, truncated } = candidate
  if (typeof code !== "string" || !SIXB_ERROR_CODE_SET.has(code)) {
    throw invalidStoredFailure("code is not a known Sixb error code")
  }
  if (!(allowedCodes as readonly string[]).includes(code)) {
    throw invalidStoredFailure("code is not allowed by this failure contract")
  }
  if (typeof message !== "string") {
    throw invalidStoredFailure("message is not a string")
  }
  if (utf8ByteLength(message) > SIXB_FAILURE_MAX_MESSAGE_BYTES) {
    throw invalidStoredFailure(`message exceeds ${SIXB_FAILURE_MAX_MESSAGE_BYTES} UTF-8 bytes`)
  }
  if (typeof retryable !== "boolean") {
    throw invalidStoredFailure("retryable is not a boolean")
  }
  if (retryable !== SIXB_ERROR_DEFINITIONS[code as SixbErrorCode].retryable) {
    throw invalidStoredFailure("retryable does not match the error code policy")
  }
  if (typeof at !== "string" || !isCanonicalIsoTimestamp(at)) {
    throw invalidStoredFailure("at is not a canonical ISO-8601 timestamp")
  }
  if (details !== undefined && !isJsonValue(details)) {
    throw invalidStoredFailure("details is not a JSON value")
  }
  if (truncated !== undefined && truncated !== true) {
    throw invalidStoredFailure("truncated must be true when present")
  }

  const failure: SixbFailure = {
    code: code as SixbErrorCode,
    message,
    retryable,
    at,
    ...(details === undefined
      ? {}
      : { details: cloneJsonValue(details, "Stored Sixb failure details") }),
    ...(truncated === true ? { truncated: true } : {}),
  }
  if (serializedByteLength(failure) > SIXB_FAILURE_MAX_SERIALIZED_BYTES) {
    throw invalidStoredFailure(
      `record exceeds ${SIXB_FAILURE_MAX_SERIALIZED_BYTES} serialized UTF-8 bytes`
    )
  }
  return failure
}

function parseStoredFailureValue(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw invalidStoredFailure("value is not valid JSON")
  }
}

function isCanonicalIsoTimestamp(value: string): boolean {
  const timestamp = new Date(value)
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value
}

function invalidStoredFailure(reason: string): Error {
  return new Error(`[Sixb] Stored failure is invalid: ${reason}.`)
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
