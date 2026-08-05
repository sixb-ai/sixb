import { cloneJsonValue, type ReadonlyJsonValue } from "../json"
import { SIXB_ERROR_DEFINITIONS } from "./catalog"
import type { SixbErrorCode, SixbFailure, SixbFailureCause } from "./types"

const DEFAULT_ERROR_CODE: SixbErrorCode = "internal.unexpected"
const MAX_CAUSE_CHAIN_DEPTH = 16

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
export function toSixbFailure(error: unknown, options: ToSixbFailureOptions = {}): SixbFailure {
  const codedError = isSixbError(error) ? error : undefined
  const code = codedError?.code ?? options.fallbackCode ?? DEFAULT_ERROR_CODE
  const details = codedError ? codedError.details : options.fallbackDetails
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

function collectCauseChain(error: unknown): readonly SixbFailureCause[] {
  const causes: SixbFailureCause[] = []
  const seen = new Set<object>()
  if (isObjectLike(error)) seen.add(error)

  let cause = readCause(error)
  while (cause !== undefined && causes.length < MAX_CAUSE_CHAIN_DEPTH) {
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
