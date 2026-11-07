import type { DatasetProducer, DatasetVersion } from "@sixb/core/lake-storage"
import { LakeStorageError } from "@sixb/core/lake-storage"

export interface SixbSchemaChangeMetadata {
  readonly addColumns?: readonly string[]
}

export interface SixbCommitMetadata {
  readonly kind: "datasetVersion"
  readonly datasetId: string
  readonly commitId?: string
  readonly mode?: DatasetVersion["mode"]
  readonly producer?: DatasetVersion["producer"]
  readonly inputs?: DatasetVersion["inputs"]
  readonly rowCount?: number
  /**
   * Rows the commit inserted and deleted in the dataset table, an updated row counting twice: what
   * DuckLake's change feed holds for this version. Absent on versions written before Sixb recorded
   * it, and on schema changes.
   */
  readonly rowChanges?: number
  /**
   * How many keyed snapshots in a row, ending with this one, replaced every row without comparing
   * them with the table first. Absent when this one compared.
   */
  readonly uncomparedReplacements?: number
  readonly validatedPrimaryKeyColumns?: readonly string[]
  readonly schemaChange?: SixbSchemaChangeMetadata
  /** As `encodeLineage` stored it: decoded only for the versions a read returns. */
  readonly lineage?: unknown
  /** As `DatasetVersion.rowsChanged`. Absent on versions written before Sixb recorded it. */
  readonly rowsChanged?: boolean
  /** As `DatasetVersion.lineageChanged`. Absent on versions written before Sixb recorded it. */
  readonly lineageChanged?: boolean
}

export function parseVersionId(versionId: string): string {
  if (!versionId.startsWith("ducklake:")) {
    throw new LakeStorageError(`[SixbDuckLake] Invalid DuckLake version id '${versionId}'.`)
  }

  const snapshotId = versionId.slice("ducklake:".length)
  if (!/^\d+$/.test(snapshotId)) {
    throw new LakeStorageError(`[SixbDuckLake] Invalid DuckLake version id '${versionId}'.`)
  }

  return snapshotId
}

export function toVersionId(snapshotId: string): string {
  return `ducklake:${snapshotId}`
}

export function parseCommitMetadata(value: unknown): SixbCommitMetadata | undefined {
  if (typeof value !== "string") {
    return undefined
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return undefined
  }

  if (
    !isRecord(parsed) ||
    !isRecord(parsed.sixb) ||
    parsed.sixb.kind !== "datasetVersion" ||
    typeof parsed.sixb.datasetId !== "string"
  ) {
    return undefined
  }

  const mode = parsed.sixb.mode
  const commitId = parsed.sixb.commitId
  const producer = parseDatasetProducer(parsed.sixb.producer)
  const rowCount = parsed.sixb.rowCount
  const rowChanges = parsed.sixb.rowChanges
  const uncomparedReplacements = parsed.sixb.uncomparedReplacements
  const validatedPrimaryKeyColumns = parsed.sixb.validatedPrimaryKeyColumns
  const { rowsChanged, lineageChanged } = parsed.sixb

  return {
    kind: "datasetVersion",
    datasetId: parsed.sixb.datasetId,
    ...(typeof commitId === "string" ? { commitId } : {}),
    ...(mode === "snapshot" || mode === "append" || mode === "merge" || mode === "schema"
      ? { mode }
      : {}),
    ...(producer === undefined ? {} : { producer }),
    ...(isDatasetVersionRefs(parsed.sixb.inputs) ? { inputs: parsed.sixb.inputs } : {}),
    ...(typeof commitId === "string" && isRowCount(rowCount) ? { rowCount } : {}),
    ...(typeof commitId === "string" && isRowCount(rowChanges) ? { rowChanges } : {}),
    ...(typeof commitId === "string" && isRowCount(uncomparedReplacements)
      ? { uncomparedReplacements }
      : {}),
    ...(typeof commitId === "string" && isValidatedPrimaryKeyColumns(validatedPrimaryKeyColumns)
      ? { validatedPrimaryKeyColumns }
      : {}),
    ...(isSchemaChangeMetadata(parsed.sixb.schemaChange)
      ? { schemaChange: parsed.sixb.schemaChange }
      : {}),
    ...(parsed.sixb.lineage === undefined ? {} : { lineage: parsed.sixb.lineage }),
    ...(typeof rowsChanged === "boolean" ? { rowsChanged } : {}),
    ...(typeof lineageChanged === "boolean" ? { lineageChanged } : {}),
  }
}

/** Whether a DuckLake snapshot's `changes_made` names one of the tables, for any change. */
export function changesTouchTables(changesMade: string, tableIds: readonly bigint[]): boolean {
  const ids = new Set(tableIds.map((tableId) => tableId.toString()))
  return changesMade.split(",").some((change) => ids.has(change.split(":")[1] ?? ""))
}

/**
 * What DuckLake records for its own maintenance of a table: flushing inlined rows to a file,
 * rewriting files that carry deletes, merging small files. These move rows between files without
 * changing which rows the table holds at any snapshot, whoever ran them.
 */
const MAINTENANCE_CHANGE_KINDS: ReadonlySet<string> = new Set([
  "inline_flush",
  "rewrite_delete",
  "merge_adjacent",
])

/** Whether a DuckLake snapshot is a maintenance commit on the table (see MAINTENANCE_CHANGE_KINDS). */
export function maintainsTable(changesMade: string, tableId: bigint): boolean {
  const tableIdText = tableId.toString()
  return changesMade.split(",").some((change) => {
    const [kind, changedTableId] = change.split(":")
    return changedTableId === tableIdText && MAINTENANCE_CHANGE_KINDS.has(kind.toLowerCase())
  })
}

/**
 * Whether a DuckLake snapshot changed a table's rows, and whether it removed any. DuckLake records
 * every row change in `changes_made`, for inlined rows (`inlined_insert:<id>`) as for files
 * (`inserted_into_table:<id>`, `deleted_from_table:<id>`); altering a table changes none.
 *
 * A maintenance commit changes no rows, like Iceberg's replace snapshots: it is never a version.
 * A flush also records `deleted_from_table` for the table, for the inlined rows it moved.
 */
export function parseTableDataChange(
  changesMade: string,
  tableId: bigint
): { readonly hasDataChange: boolean; readonly hasDeleteChange: boolean } {
  const tableIdText = tableId.toString()
  let hasDataChange = false
  let hasDeleteChange = false
  let maintenance = false

  for (const change of changesMade.split(",")) {
    const [kind, changedTableId] = change.split(":")
    if (changedTableId !== tableIdText) {
      continue
    }

    const normalizedKind = kind.toLowerCase()
    if (MAINTENANCE_CHANGE_KINDS.has(normalizedKind)) {
      maintenance = true
    }

    if (normalizedKind.includes("insert") || normalizedKind.includes("delete")) {
      hasDataChange = true
    }

    if (normalizedKind.includes("delete")) {
      hasDeleteChange = true
    }
  }

  if (maintenance) {
    return { hasDataChange: false, hasDeleteChange: false }
  }

  return { hasDataChange, hasDeleteChange }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Malformed fields are dropped rather than failing the read, and never the producer's kind: a
 * pipeline version must keep reading as one, since a pipeline version without lineage is
 * classified with every marking.
 */
function parseDatasetProducer(value: unknown): DatasetProducer | undefined {
  if (
    !isRecord(value) ||
    (value.kind !== "sync" && value.kind !== "pipeline" && value.kind !== "ingest")
  ) {
    return undefined
  }

  return {
    kind: value.kind,
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    ...(typeof value.runId === "string" ? { runId: value.runId } : {}),
    ...(typeof value.stepId === "string" ? { stepId: value.stepId } : {}),
  }
}

function isDatasetVersionRefs(value: unknown): value is NonNullable<DatasetVersion["inputs"]> {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        isRecord(item) && typeof item.datasetId === "string" && typeof item.versionId === "string"
    )
  )
}

function isSchemaChangeMetadata(value: unknown): value is SixbSchemaChangeMetadata {
  return (
    isRecord(value) &&
    (value.addColumns === undefined ||
      (Array.isArray(value.addColumns) &&
        value.addColumns.every((columnName) => typeof columnName === "string")))
  )
}

function isRowCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function isValidatedPrimaryKeyColumns(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((column) => typeof column === "string" && column.trim().length > 0) &&
    new Set(value).size === value.length
  )
}
