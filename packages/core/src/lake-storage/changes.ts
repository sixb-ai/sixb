import type { DatasetColumnDefinition } from "../datasets"
import { LakeStorageError } from "./errors"
import type { DatasetVersion, ReadDatasetChangesInput } from "./types"

/** Shared eligibility checks for providers comparing pinned row images. */
export function resolveDatasetChangeColumns(
  input: ReadDatasetChangesInput,
  before: DatasetVersion | null,
  after: DatasetVersion | null
): readonly DatasetColumnDefinition[] | null {
  for (const value of [input.datasetId, input.fromVersionId, input.toVersionId]) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new LakeStorageError(
        "[LakeStorage] Change reads require explicit dataset and version ids."
      )
    }
  }
  if (
    input.keyColumns.length === 0 ||
    new Set(input.keyColumns).size !== input.keyColumns.length ||
    input.columns.length === 0 ||
    new Set(input.columns).size !== input.columns.length ||
    input.columns.some((column) => typeof column !== "string" || column.length === 0) ||
    input.keyColumns.some((column) => !input.columns.includes(column))
  ) {
    throw new LakeStorageError(
      "[LakeStorage] Change reads require distinct columns including every key column."
    )
  }
  if (!before || !after) return null
  const oldColumns = new Map(before.schema.columns.map((column) => [column.name, column]))
  const newColumns = new Map(after.schema.columns.map((column) => [column.name, column]))
  const columns: DatasetColumnDefinition[] = []
  for (const name of input.columns) {
    const previous = oldColumns.get(name)
    const next = newColumns.get(name)
    if (!previous || !next || previous.type !== next.type) return null
    // Projection identities are nonblank strings. Other key types keep the full-read path.
    if (input.keyColumns.includes(name) && next.type !== "string") return null
    columns.push(next)
  }
  return columns
}
