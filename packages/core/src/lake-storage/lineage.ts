import type { DatasetSchema } from "../datasets"
import { LakeStorageError } from "./errors"
import type {
  DatasetColumnLineage,
  DatasetColumnRef,
  DatasetProducer,
  DatasetUnknownLineage,
  DatasetVersion,
  DatasetVersionLineage,
  DatasetVersionMode,
} from "./types"

/**
 * Resolved column lineage: each dataset version records every dataset column its values come
 * from, across every upstream step and every row it keeps from its parent. Classifying a version
 * reads only its own record, so the lake may drop older versions without changing any markings.
 *
 * Writers resolve the lineage of the rows they add (`resolveStepLineage`), and providers merge in
 * what the version keeps of its parent when they commit it (`lineageAtCommit`).
 *
 * A version that records no lineage was written before Sixb recorded it, or by a pipeline write
 * that passed none. Such a pipeline version could hold anything; any other one holds only what its
 * own columns declare. A version computed from, or keeping rows of, a version whose lineage is
 * unknown records `{ unknown }`, naming where it was lost.
 */

/** The value dependencies of one column, or undefined when the lineage does not list it. */
export function lineageColumn(
  lineage: DatasetColumnLineage,
  column: string
): readonly DatasetColumnRef[] | undefined {
  // An own-property check: a column named like an Object.prototype member is not listed.
  return Object.hasOwn(lineage.columns, column) ? lineage.columns[column] : undefined
}

export function isUnknownLineage(lineage: DatasetVersionLineage): lineage is DatasetUnknownLineage {
  return "unknown" in lineage
}

/** What a version records about its lineage, before or after it is committed. */
export type LineageRecord = Pick<
  DatasetVersion,
  "datasetId" | "schema" | "producer" | "lineage"
> & {
  readonly versionId?: string
}

/**
 * The lineage a version stands for, with the rules for versions that record none applied. A
 * stored value that is not a lineage is unknown: reading it as absent could declassify it.
 *
 * Reading no other version is what makes those rules approximate for versions written before
 * Sixb recorded lineage: one written outside a pipeline (a sync, an ingestion, a schema change)
 * on top of a pipeline version holds that version's rows, yet reads as its own columns only.
 * Treating every such version as unknown instead would classify every older sync dataset with
 * every marking, for good, since a merge keeps its parent's rows.
 */
export function versionLineage(version: LineageRecord): DatasetVersionLineage {
  const stored: unknown = version.lineage
  const subject =
    version.versionId === undefined
      ? `a version of '${version.datasetId}'`
      : `version '${version.versionId}' of '${version.datasetId}'`

  if (stored === undefined) {
    return version.producer?.kind === "pipeline"
      ? { unknown: `${subject} recorded no column lineage` }
      : ownColumns(version.schema)
  }

  return isDatasetVersionLineage(stored)
    ? stored
    : { unknown: `${subject} records a column lineage Sixb cannot read` }
}

export interface LineageAtCommitInput {
  readonly mode: DatasetVersionMode
  /** Columns of the version being committed. */
  readonly schema: DatasetSchema
  readonly producer?: DatasetProducer
  /** The lineage the writer passed, as `BeginDatasetWriteInput.lineage`. */
  readonly written?: DatasetVersionLineage
  /**
   * The dataset's latest version, which an append, a merge, or a schema change keeps the rows of.
   * A snapshot replaces it, so it is ignored for one.
   */
  readonly parent?: Pick<
    DatasetVersion,
    "datasetId" | "versionId" | "schema" | "producer" | "lineage"
  > | null
}

/**
 * The lineage a provider stores on a version it commits. Every provider calls it, with the latest
 * version as `parent`, before it decides whether the commit changes anything
 * (`hasDatasetProvenanceChanges`), and stores the result as `DatasetVersion.lineage`.
 *
 * - A snapshot records what was written.
 * - An append or a merge records what was written and what its parent records, column by column.
 * - A schema change records its parent's lineage. A column it adds holds no value yet.
 *
 * Without written lineage, a pipeline write records none, which classifies the version with every
 * marking; any other write depends on its own columns only. Returns undefined when nothing is to
 * be stored.
 */
export function lineageAtCommit(input: LineageAtCommitInput): DatasetVersionLineage | undefined {
  const parent = input.mode === "snapshot" ? undefined : (input.parent ?? undefined)

  if (input.mode === "schema") {
    return parent ? keptLineage(parent, input.schema) : ownColumns(input.schema)
  }

  const written = writtenLineage(input)
  if (!written || isUnknownLineage(written) || !parent) return written

  const kept = keptLineage(parent, input.schema)
  if (isUnknownLineage(kept)) return kept

  return canonicalLineage(
    [...written.rows, ...kept.rows],
    input.schema.columns.flatMap(({ name }) => {
      const writtenColumn = lineageColumn(written, name)
      const keptColumn = lineageColumn(kept, name)
      return writtenColumn && keptColumn ? [[name, [...writtenColumn, ...keptColumn]] as const] : []
    })
  )
}

/**
 * Lineage of a pipeline step's output across every upstream hop: each column a step reads stands
 * for itself and for everything the input version it read records for it.
 *
 * Every output column also depends on the rows of every input version the step read, whether or
 * not it names a column of that input: `SELECT count(*) FROM rich`, or a constant selected from
 * it, reveals which rows `rich` holds, and so what decided them upstream.
 *
 * `step` is the step's own lineage, whose refs name columns of `inputs`, the input versions the
 * step read. The pipeline worker passes it for `run` steps; a SQL provider passes it for the SQL it
 * executes. The result is unknown when an input's lineage is unknown, or when a column it depends
 * on comes from a dataset none of `inputs` is a version of.
 */
export function resolveStepLineage(
  step: DatasetColumnLineage,
  inputs: readonly DatasetVersion[]
): DatasetVersionLineage {
  if (!isDatasetColumnLineage(step)) {
    throw new LakeStorageError("[SixbLake] A pipeline step's column lineage is malformed.")
  }

  const inputsByDataset = new Map<string, DatasetVersion[]>()
  for (const input of inputs) {
    const versions = inputsByDataset.get(input.datasetId)
    if (versions) versions.push(input)
    else inputsByDataset.set(input.datasetId, [input])
  }

  const lineages = new Map<DatasetVersion, DatasetVersionLineage>()
  const lineageOf = (version: DatasetVersion) => {
    let lineage = lineages.get(version)
    if (!lineage) {
      lineage = versionLineage(version)
      lineages.set(version, lineage)
    }
    return lineage
  }

  const resolved = new Map<string, readonly DatasetColumnRef[] | { readonly unknown: string }>()
  /** The ref and everything the input versions record for it, or why that is unknown. */
  const resolve = (ref: DatasetColumnRef) => {
    const key = refKey(ref)
    let result = resolved.get(key)
    if (!result) {
      result = resolveRef(ref, inputsByDataset.get(ref.datasetId), lineageOf)
      resolved.set(key, result)
    }
    return result
  }

  const expand = (refs: readonly DatasetColumnRef[]) => {
    const expanded: DatasetColumnRef[] = []
    for (const ref of refs) {
      const result = resolve(ref)
      if ("unknown" in result) return result
      expanded.push(...result)
    }
    return expanded
  }

  const rows = expand(step.rows)
  if ("unknown" in rows) return rows

  for (const input of inputs) {
    const lineage = lineageOf(input)
    if (isUnknownLineage(lineage)) return lineage
    rows.push(...lineage.rows)
  }

  const columns: (readonly [string, readonly DatasetColumnRef[]])[] = []
  for (const [column, refs] of Object.entries(step.columns)) {
    const values = expand(refs)
    if ("unknown" in values) return values
    columns.push([column, values])
  }

  return canonicalLineage(rows, columns)
}

function resolveRef(
  ref: DatasetColumnRef,
  versions: readonly DatasetVersion[] | undefined,
  lineageOf: (version: DatasetVersion) => DatasetVersionLineage
): readonly DatasetColumnRef[] | { readonly unknown: string } {
  if (!versions) {
    return { unknown: `a pipeline step read '${ref.datasetId}' without recording which version` }
  }

  const refs = [ref]
  for (const version of versions) {
    const lineage = lineageOf(version)
    if (isUnknownLineage(lineage)) return lineage

    const values = lineageColumn(lineage, ref.column)
    // A column the input version does not have holds no value; one it does not list, anything.
    if (!values && version.schema.columns.some(({ name }) => name === ref.column)) {
      const subject = `version '${version.versionId}' of '${version.datasetId}'`
      return { unknown: `${subject} recorded no lineage for column '${ref.column}'` }
    }

    // The input's rows are every output column's dependencies already.
    refs.push(...(values ?? []))
  }

  return refs
}

/**
 * Whether two lineages classify alike: the same dependencies per column, whatever their order
 * and repetition, or both unknown.
 */
export function sameLineage(left: DatasetVersionLineage, right: DatasetVersionLineage): boolean {
  return lineageKey(left) === lineageKey(right)
}

function lineageKey(lineage: DatasetVersionLineage): string {
  if (isUnknownLineage(lineage)) return "unknown"
  const canonical = canonicalLineage(lineage.rows, Object.entries(lineage.columns))
  return JSON.stringify([canonical.rows, Object.entries(canonical.columns)])
}

/** What the version keeps of its parent, restricted to the columns it has. */
function keptLineage(parent: LineageRecord, schema: DatasetSchema): DatasetVersionLineage {
  const lineage = versionLineage(parent)
  if (isUnknownLineage(lineage)) return lineage

  const parentColumns = new Set(parent.schema.columns.map(({ name }) => name))
  return canonicalLineage(
    lineage.rows,
    schema.columns.flatMap(({ name }) => {
      const values = lineageColumn(lineage, name)
      // A column the parent does not have holds no value in the rows it keeps.
      if (values) return [[name, values] as const]
      return parentColumns.has(name) ? [] : [[name, []] as const]
    })
  )
}

function writtenLineage(input: LineageAtCommitInput): DatasetVersionLineage | undefined {
  const { written } = input

  if (written === undefined) {
    return input.producer?.kind === "pipeline" ? undefined : ownColumns(input.schema)
  }
  if (!isDatasetVersionLineage(written)) {
    throw new LakeStorageError("[SixbLake] The column lineage passed to the write is malformed.")
  }
  if (isUnknownLineage(written)) return { unknown: written.unknown }

  return canonicalLineage(
    written.rows,
    input.schema.columns.flatMap(({ name }) => {
      const values = lineageColumn(written, name)
      return values ? [[name, values] as const] : []
    })
  )
}

function ownColumns(schema: DatasetSchema): DatasetColumnLineage {
  return { rows: [], columns: Object.fromEntries(schema.columns.map(({ name }) => [name, []])) }
}

/**
 * Refs deduplicated and sorted, columns sorted: equal lineages store and compare alike.
 *
 * Every column depends on `rows`, so a column lists only what it depends on beyond them. Without
 * this, each hop would copy the rows of every input into every column again.
 */
function canonicalLineage(
  rows: readonly DatasetColumnRef[],
  columns: Iterable<readonly [string, readonly DatasetColumnRef[]]>
): DatasetColumnLineage {
  const canonicalRows = canonicalRefs(rows)
  const inRows = new Set(canonicalRows.map(refKey))
  const sortedColumns = [...columns].sort(([left], [right]) => compare(left, right))

  return {
    rows: canonicalRows,
    columns: Object.fromEntries(
      sortedColumns.map(([column, refs]) => [column, canonicalRefs(refs, inRows)])
    ),
  }
}

function canonicalRefs(
  refs: readonly DatasetColumnRef[],
  exclude?: ReadonlySet<string>
): readonly DatasetColumnRef[] {
  if (refs.length === 0) return []

  const unique = new Map<string, DatasetColumnRef>()
  for (const { datasetId, column } of refs) {
    const key = refKey({ datasetId, column })
    if (!exclude?.has(key)) unique.set(key, { datasetId, column })
  }

  return [...unique.entries()].sort(([left], [right]) => compare(left, right)).map(([, ref]) => ref)
}

function refKey(ref: DatasetColumnRef): string {
  return `${ref.datasetId}\u0000${ref.column}`
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function isDatasetVersionLineage(value: unknown): value is DatasetVersionLineage {
  if (typeof value !== "object" || value === null) return false
  if ("unknown" in value) return typeof value.unknown === "string"
  return isDatasetColumnLineage(value)
}

function isDatasetColumnLineage(value: unknown): value is DatasetColumnLineage {
  if (typeof value !== "object" || value === null) return false
  if (!("rows" in value) || !isRefs(value.rows)) return false
  if (!("columns" in value)) return false

  const { columns } = value
  if (typeof columns !== "object" || columns === null || Array.isArray(columns)) return false
  return Object.values(columns).every(isRefs)
}

function isRefs(value: unknown): value is readonly DatasetColumnRef[] {
  return (
    Array.isArray(value) &&
    value.every(
      (ref: unknown) =>
        typeof ref === "object" &&
        ref !== null &&
        "datasetId" in ref &&
        typeof ref.datasetId === "string" &&
        "column" in ref &&
        typeof ref.column === "string"
    )
  )
}
