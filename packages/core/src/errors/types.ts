import type { ReadonlyJsonValue } from "../json"
import type { SIXB_ERROR_DEFINITIONS } from "./catalog"

/** Stable machine-readable identity for a Sixb failure. */
export type SixbErrorCode = keyof typeof SIXB_ERROR_DEFINITIONS

/** One safely serializable entry in an error's causal chain. */
export interface SixbFailureCause {
  readonly name: string
  readonly message: string
}

/**
 * Serializable snapshot of a failure at the point where Sixb records it.
 *
 * Unlike the internal error object, this value can cross storage, HTTP, and process boundaries.
 */
export interface SixbFailure {
  readonly code: SixbErrorCode
  readonly message: string
  readonly retryable: boolean
  /** ISO-8601 UTC timestamp of the failure occurrence. */
  readonly at: string
  readonly details?: ReadonlyJsonValue
  /** Causal entries ordered from the immediate cause to the deepest available cause. */
  readonly causeChain?: readonly SixbFailureCause[]
}
