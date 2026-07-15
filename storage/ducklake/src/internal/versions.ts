import type { DatasetVersion } from "@sixb/core/lake-storage"
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
  readonly schemaChange?: SixbSchemaChangeMetadata
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
  const rowCount = parsed.sixb.rowCount

  return {
    kind: "datasetVersion",
    datasetId: parsed.sixb.datasetId,
    ...(typeof commitId === "string" ? { commitId } : {}),
    ...(mode === "snapshot" || mode === "append" || mode === "schema" ? { mode } : {}),
    ...(isDatasetProducer(parsed.sixb.producer) ? { producer: parsed.sixb.producer } : {}),
    ...(isDatasetVersionRefs(parsed.sixb.inputs) ? { inputs: parsed.sixb.inputs } : {}),
    ...(typeof commitId === "string" && isRowCount(rowCount) ? { rowCount } : {}),
    ...(isSchemaChangeMetadata(parsed.sixb.schemaChange)
      ? { schemaChange: parsed.sixb.schemaChange }
      : {}),
  }
}

export function parseInlineDataChange(
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

function isDatasetProducer(value: unknown): value is NonNullable<DatasetVersion["producer"]> {
  return (
    isRecord(value) &&
    (value.kind === "sync" || value.kind === "pipeline") &&
    optionalString(value.id) &&
    optionalString(value.runId)
  )
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

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string"
}

function isRowCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}
