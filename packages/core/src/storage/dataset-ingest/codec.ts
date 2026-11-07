import { isPlainRecord } from "../../json"
import type { DatasetRow } from "../../lake-storage/types"
import type { DatasetIngestChange } from "./types"

/**
 * A change as the inbox stores it: JSON, with the columns and sequence that held a `Date` named,
 * so a flush hands the lake the very values `ingest` validated. A `Date` in a `date` column would
 * not survive as its ISO string, which is a timestamp.
 */
type EncodedChange =
  | { readonly kind: "upsert"; readonly row: DatasetRow; readonly dateColumns?: readonly string[] }
  | {
      readonly kind: "delete"
      readonly key: DatasetRow
      readonly sequence?: string | number
      readonly sequenceIsDate?: true
    }

/** JSON text of a delivery's changes, for one column. */
export function encodeDatasetIngestChanges(changes: readonly DatasetIngestChange[]): string {
  return JSON.stringify(changes.map(encodeChange))
}

/** Changes from the text `encodeDatasetIngestChanges` wrote. */
export function decodeDatasetIngestChanges(text: string): DatasetIngestChange[] {
  const changes: unknown = JSON.parse(text)

  if (!Array.isArray(changes)) {
    throw new Error("[Sixb] Stored dataset ingest changes are not an array.")
  }

  return changes.map(decodeChange)
}

function encodeChange(change: DatasetIngestChange): EncodedChange {
  if (change.kind === "delete") {
    const { sequence } = change
    if (sequence instanceof Date) {
      return {
        kind: "delete",
        key: change.key,
        sequence: sequence.toISOString(),
        sequenceIsDate: true,
      }
    }

    return { kind: "delete", key: change.key, ...(sequence === undefined ? {} : { sequence }) }
  }

  const entries = Object.entries(change.row)
  const dateColumns = entries.filter(([, value]) => value instanceof Date).map(([column]) => column)
  const row = Object.fromEntries(
    entries.map(([column, value]) => [column, value instanceof Date ? value.toISOString() : value])
  )

  return { kind: "upsert", row, ...(dateColumns.length > 0 ? { dateColumns } : {}) }
}

function decodeChange(value: unknown): DatasetIngestChange {
  if (!isPlainRecord(value)) {
    throw new Error("[Sixb] A stored dataset ingest change is not an object.")
  }

  if (value.kind === "delete" && isPlainRecord(value.key)) {
    const { sequence } = value
    if (sequence === undefined) return { kind: "delete", key: value.key }

    if (value.sequenceIsDate === true && typeof sequence === "string") {
      return { kind: "delete", key: value.key, sequence: new Date(sequence) }
    }

    if (typeof sequence === "string" || typeof sequence === "number") {
      return { kind: "delete", key: value.key, sequence }
    }
  }

  if (value.kind === "upsert" && isPlainRecord(value.row)) {
    const dateColumns = new Set(Array.isArray(value.dateColumns) ? value.dateColumns : [])
    const row = Object.fromEntries(
      Object.entries(value.row).map(([column, cell]) => [
        column,
        dateColumns.has(column) && typeof cell === "string" ? new Date(cell) : cell,
      ])
    )

    return { kind: "upsert", row }
  }

  throw new Error("[Sixb] A stored dataset ingest change is malformed.")
}
