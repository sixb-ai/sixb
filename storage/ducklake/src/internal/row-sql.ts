import type { DuckDBValue } from "@duckdb/node-api"
import type { DatasetColumnDefinition, DatasetRow, DatasetSchema, FileRef } from "@pario/core"
import { datasetSchemaColumnNamesSql } from "./schema"
import { quoteIdentifier } from "./sql"

/**
 * Build a parameterized INSERT for one validated dataset row.
 *
 * Values are still passed separately to DuckDB; the inline SQL only supplies
 * target columns and casts for types where DuckDB's binder needs a nudge.
 */
export function buildInsertRowSql(
  stagingTableName: string,
  schema: DatasetSchema,
  row: DatasetRow
): [string, readonly DuckDBValue[]] {
  const [expressionsSql, values] = bindDatasetRow(schema, row)
  return [
    `INSERT INTO ${quoteIdentifier(stagingTableName)} (${datasetSchemaColumnNamesSql(
      schema
    )}) VALUES (${expressionsSql})`,
    values,
  ]
}

function bindDatasetRow(schema: DatasetSchema, row: DatasetRow): [string, readonly DuckDBValue[]] {
  const values: DuckDBValue[] = []
  const expressions = schema.columns.map((column) => bindColumnValue(column, row, values))

  return [expressions.join(", "), values]
}

function bindColumnValue(
  column: DatasetColumnDefinition,
  row: DatasetRow,
  values: DuckDBValue[]
): string {
  const value = row[column.name] ?? null
  if (value === null) {
    values.push(null)
    return "?"
  }

  switch (column.type) {
    // Numeric/date/json casts keep JavaScript values from being inferred as a
    // nearby but incompatible DuckDB type when inserted through placeholders.
    case "int64":
      values.push(typeof value === "bigint" ? value : BigInt(value as string | number))
      return "?::BIGINT"
    case "decimal":
      values.push(String(value))
      return "?::DECIMAL(38, 9)"
    case "date":
      values.push(value instanceof Date ? value.toISOString().slice(0, 10) : String(value))
      return "?::DATE"
    case "timestamp":
      values.push(value instanceof Date ? value.toISOString() : String(value))
      return "?::TIMESTAMPTZ"
    case "json":
      values.push(JSON.stringify(value))
      return "?::JSON"
    case "fileRef":
      return bindFileRefValue(value as FileRef, values)
    default:
      values.push(value as DuckDBValue)
      return "?"
  }
}

/**
 * Store fileRef metadata as the exact STRUCT shape Pario can reverse-map.
 * Payload bytes are handled by blob storage, not by DuckLake row data.
 */
function bindFileRefValue(fileRef: FileRef, values: DuckDBValue[]): string {
  values.push(
    fileRef.blobId,
    fileRef.digest,
    BigInt(fileRef.sizeBytes),
    fileRef.fileName ?? null,
    fileRef.mediaType ?? null,
    fileRef.logicalPath ?? null
  )

  return "struct_pack(blobId := ?::VARCHAR, digest := ?::VARCHAR, sizeBytes := ?::BIGINT, fileName := ?::VARCHAR, mediaType := ?::VARCHAR, logicalPath := ?::VARCHAR)"
}
