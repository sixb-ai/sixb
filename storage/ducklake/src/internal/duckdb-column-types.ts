import type { DatasetColumnType } from "@sixb/core"

interface DuckDbColumnTypeMapping {
  readonly sql: string
  readonly matches: (typeSql: string) => boolean
}

interface DuckDbDecimalTypeMapping extends DuckDbColumnTypeMapping {
  readonly precision: number
  readonly scale: number
}

function normalizeDuckDbTypeSql(typeSql: string): string {
  return typeSql
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ")
    .replace(/\s*([(),])\s*/g, "$1")
}

function defineDuckDbColumnType<const Sql extends string>(
  sql: Sql,
  aliases: readonly string[] = []
): DuckDbColumnTypeMapping & { readonly sql: Sql } {
  const acceptedTypes = new Set([sql, ...aliases].map(normalizeDuckDbTypeSql))
  return {
    sql,
    matches: (typeSql) => acceptedTypes.has(normalizeDuckDbTypeSql(typeSql)),
  }
}

function defineDuckDbDecimalType(precision: number, scale: number): DuckDbDecimalTypeMapping {
  return {
    ...defineDuckDbColumnType(`DECIMAL(${precision}, ${scale})`),
    precision,
    scale,
  }
}

/**
 * DuckDB representations used for every Sixb dataset column type.
 *
 * Each entry owns both its CREATE TABLE representation and the metadata
 * spellings accepted when reconstructing a Sixb dataset schema.
 */
export const DUCKDB_COLUMN_TYPES = {
  string: defineDuckDbColumnType("VARCHAR"),
  boolean: defineDuckDbColumnType("BOOLEAN"),
  int64: defineDuckDbColumnType("BIGINT", ["INT64"]),
  float64: defineDuckDbColumnType("DOUBLE", ["FLOAT64"]),
  decimal: defineDuckDbDecimalType(38, 9),
  date: defineDuckDbColumnType("DATE"),
  timestamp: defineDuckDbColumnType("TIMESTAMPTZ", ["TIMESTAMP WITH TIME ZONE"]),
  json: defineDuckDbColumnType("JSON"),
  fileRef: defineDuckDbColumnType(
    "STRUCT(blobId VARCHAR, digest VARCHAR, sizeBytes BIGINT, fileName VARCHAR, mediaType VARCHAR, logicalPath VARCHAR)"
  ),
} satisfies Record<DatasetColumnType, DuckDbColumnTypeMapping>

export function findDatasetColumnTypeForDuckDbSql(typeSql: string): DatasetColumnType | undefined {
  for (const type of Object.keys(DUCKDB_COLUMN_TYPES) as DatasetColumnType[]) {
    if (DUCKDB_COLUMN_TYPES[type].matches(typeSql)) {
      return type
    }
  }

  return undefined
}
