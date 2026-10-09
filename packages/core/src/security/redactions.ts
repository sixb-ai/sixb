import type { Redactions } from "./types"

/** List the values hidden from a reader that lacks a clearance for their markings. */
export function missingClearanceRedactions(ids: Iterable<string>): Redactions {
  return Object.fromEntries([...ids].map((id) => [id, { reason: "missing_clearance" }] as const))
}
