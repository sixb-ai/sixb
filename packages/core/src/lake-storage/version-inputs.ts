import type { DatasetVersionRef } from "./types"

/** Input lineage participates in write identity when the caller supplies it. */
export function hasDatasetInputChanges(
  previous: readonly DatasetVersionRef[] | undefined,
  next: readonly DatasetVersionRef[] | undefined
): boolean {
  if (next === undefined) return false
  const keys = (refs: readonly DatasetVersionRef[]) =>
    new Set(refs.map((ref) => JSON.stringify([ref.datasetId, ref.versionId])))
  const before = keys(previous ?? [])
  const after = keys(next)
  return before.size !== after.size || [...after].some((key) => !before.has(key))
}
