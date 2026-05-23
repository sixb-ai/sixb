import {
  type DatasetColumnDefinition,
  type DatasetColumnType,
  type DatasetSchema,
  type FileRef,
  LakeStorageError,
} from "@sixb/core"
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
 * Exact DuckDB struct shape used for Sixb `fileRef` columns.
 *
 * The reverse mapper intentionally recognizes only this shape so arbitrary
 * STRUCT or JSON columns are not reconstructed as `fileRef`.
 */
export const FILE_REF_STRUCT_SQL =
  "STRUCT(blobId VARCHAR, digest VARCHAR, sizeBytes BIGINT, fileName VARCHAR, mediaType VARCHAR, logicalPath VARCHAR)"

const DUCKDB_TYPE_BY_SIXB_TYPE: Readonly<Record<DatasetColumnType, string>> = {
  string: "VARCHAR",
  boolean: "BOOLEAN",
  int64: "BIGINT",
  float64: "DOUBLE",
  decimal: "DECIMAL(38, 9)",
  date: "DATE",
  timestamp: "TIMESTAMPTZ",
  json: "JSON",
  fileRef: FILE_REF_STRUCT_SQL,
}

function normalizeWhitespace(typeSql: string): string {
  return typeSql.trim().replace(/\s+/g, " ")
}

function normalizeSimpleType(typeSql: string): string {
  const normalized = normalizeWhitespace(typeSql).toUpperCase()
  const decimalMatch = /^DECIMAL\(\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(normalized)
  if (decimalMatch) {
    return `DECIMAL(${decimalMatch[1]}, ${decimalMatch[2]})`
  }

  return normalized
}

/**
 * Map a Sixb dataset column type to the DuckDB type used in CREATE TABLE.
 */
export function datasetColumnTypeToDuckDbSql(type: DatasetColumnType): string {
  return DUCKDB_TYPE_BY_SIXB_TYPE[type]
}

/**
 * Reconstruct a Sixb dataset column type from DuckDB column metadata.
 */
export function duckDbTypeToDatasetColumnType(typeSql: string): DatasetColumnType {
  if (normalizeWhitespace(typeSql) === FILE_REF_STRUCT_SQL) {
    return "fileRef"
  }

  switch (normalizeSimpleType(typeSql)) {
    case "VARCHAR":
      return "string"
    case "BOOLEAN":
      return "boolean"
    case "BIGINT":
    case "INT64":
      return "int64"
    case "DOUBLE":
    case "FLOAT64":
      return "float64"
    case "DECIMAL(38, 9)":
      return "decimal"
    case "DATE":
      return "date"
    case "TIMESTAMPTZ":
    case "TIMESTAMP WITH TIME ZONE":
      return "timestamp"
    case "JSON":
      return "json"
    default:
      throw new LakeStorageError(
        `[SixbDuckLake] DuckDB column type '${typeSql}' cannot be mapped to a Sixb dataset column type.`
      )
  }
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
      return typeof value === "object" && "toString" in value ? String(value) : value
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
    throw new LakeStorageError("[SixbDuckLake] DuckDB fileRef value must be a struct.")
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
    throw new LakeStorageError(`[SixbDuckLake] DuckDB fileRef field '${key}' must be a string.`)
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
    throw new LakeStorageError(`[SixbDuckLake] DuckDB fileRef field '${key}' must be a string.`)
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

  throw new LakeStorageError(`[SixbDuckLake] DuckDB fileRef field '${key}' must be an integer.`)
}
