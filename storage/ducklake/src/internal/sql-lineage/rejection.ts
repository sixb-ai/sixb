/**
 * A transform whose lineage cannot be derived exactly. The message names the construct and becomes
 * the `reason` of an unsupported analysis; it never escapes the analysis as an error.
 */
export class SqlLineageRejected extends Error {
  override readonly name = "SqlLineageRejected"
}

export function reject(reason: string): never {
  throw new SqlLineageRejected(reason)
}

/** DuckDB serialized something the analysis does not recognize, most likely after an upgrade. */
export function rejectPlanFormat(detail: string): never {
  reject(`unexpected DuckDB plan format: ${detail}`)
}
