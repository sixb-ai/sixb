import { createHash } from "node:crypto"
import type { DatasetDefinition, MergeChange } from "../datasets"
import { datasetSequenceValue } from "../datasets/sequence"
import { stableJsonStringify } from "../json"
import { normalizeDecimalValue } from "../ontology/decimal"
import { LakeStorageError } from "./errors"
import { encodeDatasetPrimaryKey } from "./merge-validation"
import type { DatasetRow } from "./types"

/** Current source revision; a null content digest is a deletion tombstone. */
export interface DatasetSequenceState {
  readonly sequence: string
  readonly content: string | null
}

export interface DatasetSequenceChange extends DatasetSequenceState {
  readonly key: string
}

export function datasetSequenceChange(
  dataset: DatasetDefinition,
  change: MergeChange<DatasetRow, DatasetRow>
): DatasetSequenceChange {
  const value = change.kind === "upsert" ? change.row[dataset.sequenceBy ?? ""] : change.sequence
  return {
    key: encodeDatasetPrimaryKey(dataset, change.kind === "upsert" ? change.row : change.key),
    sequence: datasetSequenceValue(dataset, value).toString(),
    content: change.kind === "delete" ? null : rowDigest(dataset, change.row),
  }
}

/** Process in submission order against a private copy; conflicts publish no partial state. */
export function reconcileDatasetSequences(
  dataset: DatasetDefinition,
  previous: ReadonlyMap<string, DatasetSequenceState>,
  changes: readonly DatasetSequenceChange[]
): { states: Map<string, DatasetSequenceState>; accepted: Map<string, number> } {
  const states = new Map(previous)
  const accepted = new Map<string, number>()
  for (const [index, change] of changes.entries()) {
    const current = states.get(change.key)
    if (current) {
      const difference = BigInt(change.sequence) - BigInt(current.sequence)
      if (difference < 0n) continue
      if (difference === 0n) {
        if (current.content !== change.content) {
          throw new LakeStorageError(
            `[SixbLake] Dataset '${dataset.id}' has conflicting content at source sequence '${change.sequence}' for key ${change.key}.`
          )
        }
        continue
      }
    }
    states.set(change.key, { sequence: change.sequence, content: change.content })
    accepted.set(change.key, index)
  }
  return { states, accepted }
}

function rowDigest(dataset: DatasetDefinition, row: DatasetRow): string {
  const content: Record<string, unknown> = Object.create(null)
  for (const column of dataset.schema.columns) {
    const value = row[column.name]
    // Nullable additions and omitted/undefined/null values have identical content.
    if (value == null) continue
    switch (column.type) {
      case "int64":
        content[column.name] = BigInt(value as string | number).toString()
        break
      case "timestamp":
        content[column.name] = new Date(value as string | Date).toISOString()
        break
      case "date":
        content[column.name] = new Date(value as string | Date).toISOString().slice(0, 10)
        break
      case "decimal":
        content[column.name] = normalizeDecimalValue(value as string)
        break
      default:
        content[column.name] = value
    }
  }
  return createHash("sha256")
    .update(stableJsonStringify(JSON.parse(JSON.stringify(content))))
    .digest("hex")
}

/** Until row reconciliation is supported, replacement writes must not erase source history. */
export function assertUnsequencedDatasetWrite(dataset: DatasetDefinition): void {
  if (dataset.sequenceBy !== undefined) {
    throw new LakeStorageError(
      `[SixbLake] Dataset '${dataset.id}' declares sequenceBy; use beginMerge with source-ordered changes.`
    )
  }
}
