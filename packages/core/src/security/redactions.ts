import type { Redactions } from "./types"

const MISSING_CLEARANCE = Object.freeze({ reason: "missing_clearance" } as const)

/**
 * List the values hidden from a reader that lacks a clearance for their markings. Deeply frozen,
 * so every row and event redacted the same way can share it.
 */
export function missingClearanceRedactions(ids: Iterable<string>): Redactions {
  return Object.freeze(Object.fromEntries([...ids].map((id) => [id, MISSING_CLEARANCE] as const)))
}
