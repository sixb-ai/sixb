import type { DuckDBValue } from "@duckdb/node-api"
import type { DatasetColumnDefinition, DatasetRow, DatasetSchema, FileRef } from "@sixb/core"
import { LakeValueRefusedError } from "@sixb/core/lake-storage"
import { normalizeDuckDbDecimalValue } from "./duckdb-decimal"
import type { DuckDbAppender } from "./duckdb-runtime"
import { normalizeDuckDbTimestampValue } from "./duckdb-timestamp"

/**
 * Append one validated dataset row into the staging table's DuckDB appender. `position` is where
 * the row came in what the caller was handed, for the refusal to name it.
 */
export function appendDatasetRow(
  appender: DuckDbAppender,
  schema: DatasetSchema,
  row: DatasetRow,
  position: number
): void {
  for (const column of schema.columns) {
    try {
      appendColumnValue(appender, column, row[column.name] ?? null)
    } catch (error) {
      // DuckDB converts the value as it appends it: a value its column type cannot hold, such as
      // a timestamp outside its range or an integer past 64 bits, fails here.
      throw new LakeValueRefusedError(
        `[SixbDuckLake] Column '${column.name}' cannot hold the value: ${error instanceof Error ? error.message : String(error)}`,
        { changeIndex: position, cause: error }
      )
    }
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
      appender.appendVarchar(normalizeDuckDbDecimalValue(value, column.name))
      return
    case "date":
      appender.appendVarchar(
        value instanceof Date ? value.toISOString().slice(0, 10) : String(value)
      )
      return
    case "timestamp":
      appender.appendVarchar(normalizeDuckDbTimestampValue(value))
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
