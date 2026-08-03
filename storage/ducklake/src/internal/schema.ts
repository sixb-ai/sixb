import type { DatasetColumnDefinition, DatasetColumnType, DatasetSchema, FileRef } from "@sixb/core"
import { SixbError } from "@sixb/core/errors"
import { DUCKDB_COLUMN_TYPES, findDatasetColumnTypeForDuckDbSql } from "./duckdb-column-types"
import { normalizeDuckDbDecimalValue } from "./duckdb-decimal"
import { quoteIdentifier } from "./sql"

/**
 * Normalized column metadata read from DuckDB/DuckLake introspection queries.
 */
export interface DuckDbColumnMetadata {
  readonly name: string
  readonly type: string
  readonly nullable: boolean
}

/**
 * Map a Sixb dataset column type to the DuckDB type used in CREATE TABLE.
 */
export function datasetColumnTypeToDuckDbSql(type: DatasetColumnType): string {
  return DUCKDB_COLUMN_TYPES[type].sql
}

/**
 * Reconstruct a Sixb dataset column type from DuckDB column metadata.
 */
export function duckDbTypeToDatasetColumnType(typeSql: string): DatasetColumnType {
  const type = findDatasetColumnTypeForDuckDbSql(typeSql)
  if (type) {
    return type
  }

  throw new SixbError(
    "storage.lake_failed",
    `[SixbDuckLake] DuckDB column type '${typeSql}' cannot be mapped to a Sixb dataset column type.`
  )
}

/**
 * Render one Sixb dataset column as DuckDB DDL.
 */
export function datasetColumnToDuckDbSql(column: DatasetColumnDefinition): string {
  const nullableSql = column.nullable ? "" : " NOT NULL"
  return `${quoteIdentifier(column.name)} ${datasetColumnTypeToDuckDbSql(column.type)}${nullableSql}`
}

/**
 * Render the column list used by CREATE TABLE and staging table DDL.
 */
export function datasetSchemaToDuckDbColumnsSql(schema: DatasetSchema): string {
  return schema.columns.map((column) => datasetColumnToDuckDbSql(column)).join(", ")
}

/**
 * Render the column list used by INSERT ... SELECT operations.
 */
export function datasetSchemaColumnNamesSql(schema: DatasetSchema): string {
  return schema.columns.map((column) => quoteIdentifier(column.name)).join(", ")
}

/**
 * Convert DuckDB column metadata back into a Sixb dataset schema.
 */
export function duckDbColumnsToDatasetSchema(
  columns: readonly DuckDbColumnMetadata[]
): DatasetSchema {
  return {
    columns: columns.map((column) => ({
      name: column.name,
      type: duckDbTypeToDatasetColumnType(column.type),
      ...(column.nullable ? { nullable: true } : {}),
    })),
  }
}

export function normalizeReadValue(value: unknown, column: DatasetColumnDefinition): unknown {
  if (value === null || value === undefined) {
    return null
  }

  switch (column.type) {
    case "int64":
      return typeof value === "bigint" ? value.toString() : value
    case "decimal":
      return normalizeDuckDbDecimalValue(value, column.name)
    case "date":
      return value instanceof Date ? value.toISOString().slice(0, 10) : String(value)
    case "timestamp":
      return value instanceof Date ? value.toISOString() : String(value)
    case "json":
      return typeof value === "string" ? JSON.parse(value) : value
    case "fileRef":
      return normalizeFileRef(value)
    default:
      return value
  }
}

function normalizeFileRef(value: unknown): FileRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SixbError(
      "storage.lake_failed",
      "[SixbDuckLake] DuckDB fileRef value must be a struct."
    )
  }

  const record = value as Record<string, unknown>
  return {
    blobId: getStringField(record, "blobId"),
    digest: getStringField(record, "digest") as FileRef["digest"],
    sizeBytes: getIntegerField(record, "sizeBytes"),
    fileName: getOptionalStringField(record, "fileName"),
    mediaType: getOptionalStringField(record, "mediaType"),
    logicalPath: getOptionalStringField(record, "logicalPath"),
  }
}

function getStringField(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = record[key]
  if (typeof value !== "string") {
    throw new SixbError(
      "storage.lake_failed",
      `[SixbDuckLake] DuckDB fileRef field '${key}' must be a string.`
    )
  }

  return value
}

function getOptionalStringField(
  record: Readonly<Record<string, unknown>>,
  key: string
): string | undefined {
  const value = record[key]
  if (value === null || value === undefined) {
    return undefined
  }

  if (typeof value !== "string") {
    throw new SixbError(
      "storage.lake_failed",
      `[SixbDuckLake] DuckDB fileRef field '${key}' must be a string.`
    )
  }

  return value
}

function getIntegerField(record: Readonly<Record<string, unknown>>, key: string): number {
  const value = record[key]
  if (typeof value === "number" && Number.isInteger(value)) {
    return value
  }

  if (typeof value === "bigint") {
    return Number(value)
  }

  throw new SixbError(
    "storage.lake_failed",
    `[SixbDuckLake] DuckDB fileRef field '${key}' must be an integer.`
  )
}
