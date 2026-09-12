import { cloneJsonValue, isJsonValue, isPlainRecord, type ReadonlyJsonValue } from "../json"
import { SIXB_ERROR_CODES, SIXB_ERROR_DEFINITIONS } from "./catalog"
import { createFailureRedactor } from "./redaction"
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
  try {
    return error instanceof SixbError
  } catch {
    return false
  }
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
  const redactor = createFailureRedactor()
  const details = error.details === undefined ? undefined : redactor.context(error.details)
  const { detail, truncated } = findFailureDetail(error, code)
  const summary = SIXB_ERROR_DEFINITIONS[code].publicMessage
  const message = truncateUtf8(
    redactor.text(detail && detail.message !== summary ? `${summary} ${detail.message}` : summary),
    SIXB_FAILURE_MAX_MESSAGE_BYTES
  )
  const failure: SixbFailure = {
    code,
    message: message.value,
    retryable: SIXB_ERROR_DEFINITIONS[code].retryable,
    at: failureTimestamp(options.at),
    ...(details === undefined ? {} : { details: cloneJsonValue(details, "Sixb failure details") }),
    ...(detail?.httpStatus === undefined ? {} : { httpStatus: detail.httpStatus }),
    ...(redactor.redacted ? { redacted: true } : {}),
    ...(message.truncated || truncated || redactor.truncated ? { truncated: true } : {}),
  }

  if (serializedByteLength(failure) <= SIXB_FAILURE_MAX_SERIALIZED_BYTES) return failure

  return {
    code: failure.code,
    message: failure.message,
    retryable: failure.retryable,
    at: failure.at,
    ...(failure.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus }),
    ...(failure.redacted ? { redacted: true } : {}),
    truncated: true,
  }
}

const NETWORK_MESSAGES: Readonly<Record<string, string>> = {
  ECONNREFUSED: "The remote service refused the connection.",
  ECONNRESET: "The remote service reset the connection.",
  ENOTFOUND: "The remote host could not be resolved.",
  EAI_AGAIN: "DNS resolution temporarily failed.",
  ETIMEDOUT: "The connection timed out.",
}

function isHttpStatus(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
}

/** Select one explanation along the causal chain; unrelated aggregate errors stay separate. */
function findFailureDetail(
  error: SixbCodedError,
  boundaryCode: SixbErrorCode
): { detail?: { message: string; httpStatus?: number }; truncated: boolean } {
  const seen = new Set<object>()
  let current: unknown = error
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    if (seen.size === 8) return { truncated: true }
    seen.add(current)
    if (
      isSixbError(current) &&
      current.code !== boundaryCode &&
      current.code !== "internal.unexpected"
    ) {
      return {
        detail: { message: SIXB_ERROR_DEFINITIONS[current.code].publicMessage },
        truncated: false,
      }
    }
    try {
      // Read only data properties: arbitrary messages and getters remain private.
      const status =
        Object.getOwnPropertyDescriptor(current, "status")?.value ??
        Object.getOwnPropertyDescriptor(current, "statusCode")?.value
      if (isHttpStatus(status)) {
        return {
          detail: { message: `Upstream request returned HTTP ${status}.`, httpStatus: status },
          truncated: false,
        }
      }
      const code = Object.getOwnPropertyDescriptor(current, "code")?.value
      if (typeof code === "string" && Object.hasOwn(NETWORK_MESSAGES, code)) {
        return { detail: { message: NETWORK_MESSAGES[code] }, truncated: false }
      }
      current = Object.getOwnPropertyDescriptor(current, "cause")?.value
    } catch {
      break
    }
  }
  return { truncated: false }
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

  const { code, message, retryable, at, details, httpStatus, redacted, truncated } = candidate
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

  if (redacted !== undefined && redacted !== true) {
    throw invalidStoredFailure("redacted must be true when present")
  }
  if (httpStatus !== undefined && !isHttpStatus(httpStatus)) {
    throw invalidStoredFailure("httpStatus must be an integer HTTP status")
  }
  const redactor = createFailureRedactor()
  const safeMessage = truncateUtf8(redactor.text(message), SIXB_FAILURE_MAX_MESSAGE_BYTES)
  const safeDetails =
    details === undefined ? undefined : redactor.context(details as ReadonlyJsonValue)

  const failure: SixbFailure = {
    code: code as SixbErrorCode,
    message: safeMessage.value,
    retryable,
    at,
    ...(safeDetails === undefined
      ? {}
      : { details: cloneJsonValue(safeDetails, "Stored Sixb failure details") }),
    ...(httpStatus === undefined ? {} : { httpStatus: httpStatus as number }),
    ...(redacted || redactor.redacted ? { redacted: true } : {}),
    ...(truncated || redactor.truncated || safeMessage.truncated ? { truncated: true } : {}),
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
 * `toSixbFailure()` constructs a message from recognized HTTP, network, or Sixb information instead.
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
