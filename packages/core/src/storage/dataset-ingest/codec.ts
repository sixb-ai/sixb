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

/**
 * PostgreSQL `jsonb` refuses U+0000 in any string. A delivery holding one stores its changes with
 * every string, object keys included, escaped: `\` becomes `\\` and U+0000 becomes `\0`. Escaping
 * all of them, not only those holding U+0000, keeps the decoding unambiguous.
 */
interface NulEscapedChanges {
  readonly nulEscaped: true
  readonly changes: readonly unknown[]
}

/** JSON text of a delivery's changes, for one column. */
export function encodeDatasetIngestChanges(changes: readonly DatasetIngestChange[]): string {
  const encoded = changes.map(encodeChange)
  if (!holdsNul(encoded)) return JSON.stringify(encoded)

  const escaped: NulEscapedChanges = {
    nulEscaped: true,
    changes: mapStrings(encoded, escapeString) as unknown[],
  }
  return JSON.stringify(escaped)
}

/** Changes from the column `encodeDatasetIngestChanges` filled, as text or as parsed JSON. */
export function decodeDatasetIngestChanges(value: unknown): DatasetIngestChange[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value
  const changes =
    isPlainRecord(parsed) && parsed.nulEscaped === true && Array.isArray(parsed.changes)
      ? (mapStrings(parsed.changes, unescapeString) as unknown[])
      : parsed

  if (!Array.isArray(changes)) {
    throw new Error("[Sixb] Stored dataset ingest changes are not an array.")
  }

  return changes.map(decodeChange)
}

function holdsNul(value: unknown): boolean {
  if (typeof value === "string") return value.includes("\u0000")
  if (Array.isArray(value)) return value.some(holdsNul)
  if (isPlainRecord(value)) {
    return Object.entries(value).some(([key, item]) => key.includes("\u0000") || holdsNul(item))
  }
  return false
}

/** Every string of a JSON value, object keys included, mapped. */
function mapStrings(value: unknown, map: (text: string) => string): unknown {
  if (typeof value === "string") return map(value)
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, map))
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [map(key), mapStrings(item, map)])
    )
  }
  return value
}

function escapeString(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll("\u0000", "\\0")
}

function unescapeString(text: string): string {
  return text.replaceAll(/\\([\\0])/g, (_match, escaped: string) =>
    escaped === "0" ? "\u0000" : "\\"
  )
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
