import type {
  DatasetColumnLineage,
  DatasetColumnRef,
  DatasetVersionLineage,
} from "@sixb/core/lake-storage"

/**
 * How a version's resolved lineage is stored in DuckLake commit metadata.
 *
 * A resolved lineage repeats the same dataset ids and column names across thousands of refs, and
 * every catalog scan reads the commit metadata of every snapshot it passes, wanted or not. So each
 * distinct string is stored once and refs are index pairs, and the encoded lineage is one JSON
 * string inside the metadata: parsing the metadata copies it without building its refs, which
 * only the versions a read returns decode.
 */
interface EncodedColumnLineage {
  readonly v: 1
  /** Every distinct dataset id, column name, and lineage column name. */
  readonly strings: readonly string[]
  /** Row refs as flat index pairs: dataset id, column. */
  readonly rows: readonly number[]
  /** One entry per column: its name's index, then its refs as flat index pairs. */
  readonly columns: readonly (readonly number[])[]
}

export function encodeLineage(lineage: DatasetVersionLineage): string {
  if ("unknown" in lineage) {
    return JSON.stringify({ unknown: lineage.unknown })
  }

  const strings: string[] = []
  const indexes = new Map<string, number>()
  const indexOf = (value: string) => {
    let index = indexes.get(value)
    if (index === undefined) {
      index = strings.length
      strings.push(value)
      indexes.set(value, index)
    }
    return index
  }
  const encodeRefs = (refs: readonly DatasetColumnRef[]) =>
    refs.flatMap((ref) => [indexOf(ref.datasetId), indexOf(ref.column)])

  const encoded: EncodedColumnLineage = {
    v: 1,
    strings,
    rows: encodeRefs(lineage.rows),
    columns: Object.entries(lineage.columns).map(([column, refs]) => [
      indexOf(column),
      ...encodeRefs(refs),
    ]),
  }
  return JSON.stringify(encoded)
}

/**
 * The stored lineage, as stored. One Sixb cannot read is unknown, as Sixb reads a malformed
 * lineage: dropping it instead would classify a version outside pipelines by its own columns only.
 */
export function decodeLineage(datasetId: string, stored: unknown): DatasetVersionLineage {
  const parsed = typeof stored === "string" ? parseJson(stored) : undefined
  if (isRecord(parsed) && Object.hasOwn(parsed, "unknown")) {
    return typeof parsed.unknown === "string" ? { unknown: parsed.unknown } : unreadable(datasetId)
  }

  return decodeColumnLineage(parsed) ?? unreadable(datasetId)
}

function decodeColumnLineage(value: unknown): DatasetColumnLineage | undefined {
  if (!isRecord(value) || value.v !== 1 || !isStringList(value.strings)) {
    return undefined
  }

  const { strings } = value
  const decodeRefs = (flat: readonly unknown[], from: number) => {
    if ((flat.length - from) % 2 !== 0) {
      return undefined
    }

    const refs: DatasetColumnRef[] = []
    for (let index = from; index < flat.length; index += 2) {
      const datasetId = stringAt(strings, flat[index])
      const column = stringAt(strings, flat[index + 1])
      if (datasetId === undefined || column === undefined) {
        return undefined
      }
      refs.push({ datasetId, column })
    }
    return refs
  }

  const rows = Array.isArray(value.rows) ? decodeRefs(value.rows, 0) : undefined
  if (rows === undefined || !Array.isArray(value.columns)) {
    return undefined
  }

  // A column listed twice would read as its last entry: a tampered record could narrow it.
  const columns = new Map<string, DatasetColumnRef[]>()
  for (const entry of value.columns) {
    const name = Array.isArray(entry) ? stringAt(strings, entry[0]) : undefined
    const refs = name === undefined ? undefined : decodeRefs(entry, 1)
    if (name === undefined || refs === undefined || columns.has(name)) {
      return undefined
    }
    columns.set(name, refs)
  }

  return { rows, columns: Object.fromEntries(columns) }
}

function unreadable(datasetId: string): DatasetVersionLineage {
  return { unknown: `a version of '${datasetId}' records a column lineage Sixb cannot read` }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function stringAt(strings: readonly string[], index: unknown): string | undefined {
  return typeof index === "number" && Number.isInteger(index) ? strings[index] : undefined
}

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
