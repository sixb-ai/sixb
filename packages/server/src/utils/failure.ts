import type { ActionRunFailure } from "@sixb/core/storage"

/**
 * Narrows a failure record to the shape the HTTP schemas still declare.
 *
 * Temporary. The schemas describe the failure as it looked before it had a code — a bare message,
 * sometimes a phase — and widening them regenerates the client, which this change does exactly once,
 * in the commit that puts the record on the wire. Until then a route drops what the schema does not
 * declare here, in one place, rather than handing over the whole record and trusting response
 * validation to quietly strip the code.
 */
export function toWireFailure(
  failure: ActionRunFailure | undefined
): { message: string; phase?: ActionRunFailure["phase"] } | undefined {
  if (!failure) return undefined
  return { message: failure.message, ...(failure.phase ? { phase: failure.phase } : {}) }
}
