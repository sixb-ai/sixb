import { MaterializationValidationError } from "../../materialization/errors"

export interface MaterializationBatching {
  readonly sourceStageRows: number
  readonly sourceStageBytes: number
  readonly statePageRows: number
  readonly planChunkRows: number
  readonly planChunkBytes: number
}

export const DEFAULT_MATERIALIZATION_BATCHING: MaterializationBatching = Object.freeze({
  // Source staging pays execution fencing, manifest locking, conflict reconciliation, and one
  // provider transaction per chunk. Two thousand rows cuts that fixed cost without the large RSS
  // increase observed when every materialization boundary was raised to five thousand.
  sourceStageRows: 2_000,
  sourceStageBytes: 4 * 1024 * 1024,
  statePageRows: 1_000,
  planChunkRows: 1_000,
  planChunkBytes: 4 * 1024 * 1024,
})

/** Internal test/provider override. Application configuration never exposes these chunk targets. */
export function resolveMaterializationBatching(
  overrides: Partial<MaterializationBatching> = {}
): MaterializationBatching {
  const resolved = { ...DEFAULT_MATERIALIZATION_BATCHING, ...overrides }
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new MaterializationValidationError(
        `Materialization batching '${name}' must be a positive safe integer.`
      )
    }
  }
  return Object.freeze(resolved)
}
