import type { ReadonlyJsonValue } from "../json"
import type { SIXB_ERROR_DEFINITIONS } from "./catalog"

/** Stable machine-readable identity for a Sixb failure. */
export type SixbErrorCode = keyof typeof SIXB_ERROR_DEFINITIONS

/**
 * Serializable snapshot of a failure at the point where Sixb records it.
 *
 * Unlike the internal error object, this value can cross storage, HTTP, and process boundaries.
 */
export interface SixbFailure<TCode extends SixbErrorCode = SixbErrorCode> {
  readonly code: TCode
  readonly message: string
  readonly retryable: boolean
  /** ISO-8601 UTC timestamp of the failure occurrence. */
  readonly at: string
  readonly details?: ReadonlyJsonValue
  /** Present when optional context exceeded the durable failure size budget and was omitted. */
  readonly truncated?: true
}
