import type { DatasetVersion } from "@pario/core"
import { LakeStorageError } from "@pario/core"

export interface ParioSchemaChangeMetadata {
  readonly addColumns?: readonly string[]
}

export interface ParioCommitMetadata {
  readonly kind: "datasetVersion"
  readonly datasetId: string
  readonly commitId?: string
  readonly mode?: DatasetVersion["mode"]
  readonly producer?: DatasetVersion["producer"]
  readonly inputs?: DatasetVersion["inputs"]
  readonly rowCount?: number
  readonly schemaChange?: ParioSchemaChangeMetadata
}

export function parseVersionId(versionId: string): string {
  if (!versionId.startsWith("ducklake:")) {
    throw new LakeStorageError(`[ParioDuckLake] Invalid DuckLake version id '${versionId}'.`)
  }

  const snapshotId = versionId.slice("ducklake:".length)
  if (!/^\d+$/.test(snapshotId)) {
    throw new LakeStorageError(`[ParioDuckLake] Invalid DuckLake version id '${versionId}'.`)
  }

  return snapshotId
}

export function toVersionId(snapshotId: string): string {
  return `ducklake:${snapshotId}`
}

export function parseCommitMetadata(value: unknown): ParioCommitMetadata | undefined {
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
    !isRecord(parsed.pario) ||
    parsed.pario.kind !== "datasetVersion" ||
    typeof parsed.pario.datasetId !== "string"
  ) {
    return undefined
  }

  const mode = parsed.pario.mode
  const commitId = parsed.pario.commitId
  const rowCount = parsed.pario.rowCount

  return {
    kind: "datasetVersion",
    datasetId: parsed.pario.datasetId,
    ...(typeof commitId === "string" ? { commitId } : {}),
    ...(mode === "snapshot" || mode === "append" || mode === "schema" ? { mode } : {}),
    ...(isDatasetProducer(parsed.pario.producer) ? { producer: parsed.pario.producer } : {}),
    ...(isDatasetVersionRefs(parsed.pario.inputs) ? { inputs: parsed.pario.inputs } : {}),
    ...(typeof commitId === "string" && isRowCount(rowCount) ? { rowCount } : {}),
    ...(isSchemaChangeMetadata(parsed.pario.schemaChange)
      ? { schemaChange: parsed.pario.schemaChange }
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

function isSchemaChangeMetadata(value: unknown): value is ParioSchemaChangeMetadata {
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
