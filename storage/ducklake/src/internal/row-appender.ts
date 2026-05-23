import type { DuckDBValue } from "@duckdb/node-api"
import type { DatasetColumnDefinition, DatasetRow, DatasetSchema, FileRef } from "@sixb/core"
import type { DuckDbAppender } from "./duckdb-runtime"

/**
 * Append one validated dataset row into the staging table's DuckDB appender.
 */
export function appendDatasetRow(
  appender: DuckDbAppender,
  schema: DatasetSchema,
  row: DatasetRow
): void {
  for (const column of schema.columns) {
    appendColumnValue(appender, column, row[column.name] ?? null)
  }

  appender.endRow()
}

function appendColumnValue(
  appender: DuckDbAppender,
  column: DatasetColumnDefinition,
  value: unknown
): void {
  if (value === null || value === undefined) {
    appender.appendNull()
    return
  }

  switch (column.type) {
    case "string":
      appender.appendVarchar(value as string)
      return
    case "boolean":
      appender.appendBoolean(value as boolean)
      return
    case "int64":
      appender.appendBigInt(typeof value === "bigint" ? value : BigInt(value as string | number))
      return
    case "float64":
      appender.appendDouble(value as number)
      return
    case "decimal":
      appender.appendVarchar(String(value))
      return
    case "date":
      appender.appendVarchar(
        value instanceof Date ? value.toISOString().slice(0, 10) : String(value)
      )
      return
    case "timestamp":
      appender.appendVarchar(value instanceof Date ? value.toISOString() : String(value))
      return
    case "json":
      appender.appendVarchar(JSON.stringify(value))
      return
    case "fileRef":
      appender.appendStruct(fileRefToDuckDbStruct(value as FileRef))
      return
  }
}

function fileRefToDuckDbStruct(fileRef: FileRef): Readonly<Record<string, DuckDBValue>> {
  return {
    blobId: fileRef.blobId,
    digest: fileRef.digest,
    sizeBytes: BigInt(fileRef.sizeBytes),
    fileName: fileRef.fileName ?? null,
    mediaType: fileRef.mediaType ?? null,
    logicalPath: fileRef.logicalPath ?? null,
  }
}
