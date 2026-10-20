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
  readonly validatedPrimaryKeyColumns?: readonly string[]
  readonly schemaChange?: SixbSchemaChangeMetadata
  /** As `encodeLineage` stored it: decoded only for the versions a read returns. */
  readonly lineage?: unknown
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
  const validatedPrimaryKeyColumns = parsed.sixb.validatedPrimaryKeyColumns

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
    ...(typeof commitId === "string" && isValidatedPrimaryKeyColumns(validatedPrimaryKeyColumns)
      ? { validatedPrimaryKeyColumns }
      : {}),
    ...(isSchemaChangeMetadata(parsed.sixb.schemaChange)
      ? { schemaChange: parsed.sixb.schemaChange }
      : {}),
    ...(parsed.sixb.lineage === undefined ? {} : { lineage: parsed.sixb.lineage }),
  }
}

/** Whether a DuckLake snapshot's `changes_made` names one of the tables, for any change. */
export function changesTouchTables(changesMade: string, tableIds: readonly bigint[]): boolean {
  const ids = new Set(tableIds.map((tableId) => tableId.toString()))
  return changesMade.split(",").some((change) => ids.has(change.split(":")[1] ?? ""))
}

/**
 * Whether a DuckLake snapshot changed a table's rows, and whether it removed any. DuckLake records
 * every row change in `changes_made`, for inlined rows (`inlined_insert:<id>`) as for files
 * (`inserted_into_table:<id>`, `deleted_from_table:<id>`); altering a table changes none.
 */
export function parseTableDataChange(
  changesMade: string,
  tableId: bigint
): { readonly hasDataChange: boolean; readonly hasDeleteChange: boolean } {
  const tableIdText = tableId.toString()
  let hasDataChange = false
  let hasDeleteChange = false

  for (const change of changesMade.split(",")) {
    const [kind, changedTableId] = change.split(":")
    if (changedTableId !== tableIdText) {
      continue
    }

    const normalizedKind = kind.toLowerCase()
    if (normalizedKind.includes("insert") || normalizedKind.includes("delete")) {
      hasDataChange = true
    }

    if (normalizedKind.includes("delete")) {
      hasDeleteChange = true
    }
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
