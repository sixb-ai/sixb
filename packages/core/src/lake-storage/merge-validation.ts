import type { DatasetDefinition, MergeChange } from "../datasets"
import { getDatasetRowValidationError } from "../datasets"
import { isPlainRecord } from "../json"
import { LakeStorageError } from "./errors"
import type { DatasetRow } from "./types"

/** Return a new ordered primary-key column list, or `null` for an unkeyed dataset. */
export function getDatasetPrimaryKeyColumns(dataset: DatasetDefinition): readonly string[] | null {
  if (dataset.primaryKey === undefined) {
    return null
  }
  return typeof dataset.primaryKey === "string" ? [dataset.primaryKey] : [...dataset.primaryKey]
}

/** Collision-safe internal identity for a validated row or delete-key object. */
export function encodeDatasetPrimaryKey(dataset: DatasetDefinition, value: DatasetRow): string {
  const columns = getDatasetPrimaryKeyColumns(dataset)
  if (columns === null) {
    throw new LakeStorageError(
      `[SixbLake] Dataset '${dataset.id}' must define a primaryKey before rows can be keyed.`
    )
  }

  const values = columns.map((columnName) => {
    const columnValue = value[columnName]
    if (typeof columnValue !== "string") {
      throw new LakeStorageError(
        `[SixbLake] Dataset '${dataset.id}' primary-key column '${columnName}' must be a string.`
      )
    }
    return columnValue
  })
  return JSON.stringify(values)
}

export function getDatasetMergeChangeValidationError(
  change: unknown,
  dataset: DatasetDefinition
): string | null {
  const primaryKeyColumns = getDatasetPrimaryKeyColumns(dataset)
  if (primaryKeyColumns === null) {
    return `Dataset '${dataset.id}' must define a primaryKey before it can be merged.`
  }
  if (!isPlainRecord(change)) {
    return `Dataset '${dataset.id}' merge changes must be plain objects.`
  }

  if (change.kind === "upsert") {
    const shapeError = getChangeShapeError(change, dataset, "row")
    if (shapeError) {
      return shapeError
    }
    return getDatasetRowValidationError(change.row, dataset)
  }

  if (change.kind === "delete") {
    const shapeError = getChangeShapeError(change, dataset, "key")
    if (shapeError) {
      return shapeError
    }
    return getDeleteKeyValidationError(change.key, dataset, primaryKeyColumns)
  }

  return `Dataset '${dataset.id}' merge change kind must be 'upsert' or 'delete'.`
}

/** Clone a validated change before a provider stages it beyond the caller's ownership. */
export function cloneDatasetMergeChange(
  change: MergeChange<DatasetRow, DatasetRow>
): MergeChange<DatasetRow, DatasetRow> {
  return change.kind === "upsert"
    ? { kind: "upsert", row: structuredClone(change.row) }
    : { kind: "delete", key: structuredClone(change.key) }
}

function getChangeShapeError(
  change: Record<string, unknown>,
  dataset: DatasetDefinition,
  payloadField: "row" | "key"
): string | null {
  const allowedFields = new Set(["kind", payloadField])
  for (const field of Object.keys(change)) {
    if (!allowedFields.has(field)) {
      return `Dataset '${dataset.id}' ${change.kind as string} change contains unknown field '${field}'.`
    }
  }
  if (!Object.hasOwn(change, payloadField)) {
    return `Dataset '${dataset.id}' ${change.kind as string} change is missing '${payloadField}'.`
  }
  return null
}

function getDeleteKeyValidationError(
  key: unknown,
  dataset: DatasetDefinition,
  primaryKeyColumns: readonly string[]
): string | null {
  if (!isPlainRecord(key)) {
    return `Dataset '${dataset.id}' delete keys must be plain objects.`
  }

  const expectedColumns = new Set(primaryKeyColumns)
  for (const columnName of Object.keys(key)) {
    if (!expectedColumns.has(columnName)) {
      return `Dataset '${dataset.id}' delete key contains unknown column '${columnName}'.`
    }
  }
  for (const columnName of primaryKeyColumns) {
    if (!Object.hasOwn(key, columnName)) {
      return `Dataset '${dataset.id}' delete key is missing primary-key column '${columnName}'.`
    }
    if (typeof key[columnName] !== "string") {
      return `Dataset '${dataset.id}' delete key column '${columnName}' must be a string.`
    }
  }
  return null
}
