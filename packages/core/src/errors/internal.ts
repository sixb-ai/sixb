import { cloneJsonValue, isJsonValue, isPlainRecord, type ReadonlyJsonValue } from "../json"
import { SIXB_ERROR_CODES, SIXB_ERROR_DEFINITIONS } from "./catalog"
import type { SixbErrorCode, SixbFailure, SixbFailureCause } from "./types"

const DEFAULT_ERROR_CODE: SixbErrorCode = "internal.unexpected"
export const SIXB_FAILURE_MAX_CAUSE_CHAIN_DEPTH = 16
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
  /** Code used only when `error` was not created by `createSixbError`. */
  readonly fallbackCode?: SixbErrorCode
  /** Details used only when `error` was not created by `createSixbError`. */
  readonly fallbackDetails?: ReadonlyJsonValue
}

export interface ToScopedSixbFailureOptions<TCodes extends SixbErrorCodeTuple>
  extends ToSixbFailureOptions {
  /** Codes this boundary is allowed to expose. */
  readonly allowedCodes: TCodes
  /** Used when the thrown value is uncoded or its code is outside this boundary's contract. */
  readonly fallbackCode: TCodes[number]
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

/** Identifies errors created by Sixb without making their class part of the contract. */
export function isSixbError(error: unknown): error is SixbCodedError {
  return error instanceof SixbError
}

/**
 * Takes a detached, serializable snapshot of any thrown value.
 *
 * New code should throw `createSixbError(...)`. The fallback fields are the migration bridge for
 * existing errors until their primitive receives its vertical refactor.
 */
export function toSixbFailure<const TCodes extends SixbErrorCodeTuple>(
  error: unknown,
  options: ToScopedSixbFailureOptions<TCodes>
): SixbFailure<TCodes[number]>
export function toSixbFailure(error: unknown, options?: ToSixbFailureOptions): SixbFailure
export function toSixbFailure(
  error: unknown,
  options: ToSixbFailureOptions | ToScopedSixbFailureOptions<SixbErrorCodeTuple> = {}
): SixbFailure {
  const codedError = isSixbError(error) ? error : undefined
  const allowedCodes = "allowedCodes" in options ? new Set(options.allowedCodes) : undefined
  const useCodedError = codedError && (!allowedCodes || allowedCodes.has(codedError.code))
  const code = useCodedError ? codedError.code : (options.fallbackCode ?? DEFAULT_ERROR_CODE)
  const details = useCodedError ? codedError.details : options.fallbackDetails
  const causeChain = collectCauseChain(error)

  return {
    code,
    message: summarizeError(error).message,
    retryable: SIXB_ERROR_DEFINITIONS[code].retryable,
    at: failureTimestamp(options.at),
    ...(details === undefined ? {} : { details: cloneJsonValue(details, "Sixb failure details") }),
    ...(causeChain.length === 0 ? {} : { causeChain }),
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

  const { code, message, retryable, at, details, causeChain } = candidate
  if (typeof code !== "string" || !SIXB_ERROR_CODE_SET.has(code)) {
    throw invalidStoredFailure("code is not a known Sixb error code")
  }
  if (!(allowedCodes as readonly string[]).includes(code)) {
    throw invalidStoredFailure("code is not allowed by this failure contract")
  }
  if (typeof message !== "string") {
    throw invalidStoredFailure("message is not a string")
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

  const parsedCauseChain = parseFailureCauseChain(causeChain)
  return {
    code: code as SixbErrorCode,
    message,
    retryable,
    at,
    ...(details === undefined
      ? {}
      : { details: cloneJsonValue(details, "Stored Sixb failure details") }),
    ...(parsedCauseChain === undefined ? {} : { causeChain: parsedCauseChain }),
  }
}

function parseStoredFailureValue(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw invalidStoredFailure("value is not valid JSON")
  }
}

function parseFailureCauseChain(value: unknown): readonly SixbFailureCause[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > SIXB_FAILURE_MAX_CAUSE_CHAIN_DEPTH) {
    throw invalidStoredFailure(
      `causeChain must contain at most ${SIXB_FAILURE_MAX_CAUSE_CHAIN_DEPTH} entries`
    )
  }

  return value.map((entry, index) => {
    if (
      !isPlainRecord(entry) ||
      typeof entry.name !== "string" ||
      typeof entry.message !== "string"
    ) {
      throw invalidStoredFailure(`causeChain[${index}] must contain string name and message fields`)
    }
    return { name: entry.name, message: entry.message }
  })
}

function isCanonicalIsoTimestamp(value: string): boolean {
  const timestamp = new Date(value)
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value
}

function invalidStoredFailure(reason: string): Error {
  return new Error(`[Sixb] Stored failure is invalid: ${reason}.`)
}

function collectCauseChain(error: unknown): readonly SixbFailureCause[] {
  const causes: SixbFailureCause[] = []
  const seen = new Set<object>()
  if (isObjectLike(error)) seen.add(error)

  let cause = readCause(error)
  while (cause !== undefined && causes.length < SIXB_FAILURE_MAX_CAUSE_CHAIN_DEPTH) {
    if (isObjectLike(cause)) {
      if (seen.has(cause)) break
      seen.add(cause)
    }

    causes.push(summarizeError(cause))
    cause = readCause(cause)
  }

  return causes
}

function summarizeError(value: unknown): SixbFailureCause {
  const message = readStringProperty(value, "message")
  const name = readStringProperty(value, "name")

  return {
    name: name?.trim() ? name : "Error",
    message: message ?? safeString(value),
  }
}

function readCause(value: unknown): unknown {
  if (!isObjectLike(value)) return undefined
  try {
    return Reflect.get(value, "cause")
  } catch {
    return undefined
  }
}

function readStringProperty(value: unknown, property: "message" | "name"): string | undefined {
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
