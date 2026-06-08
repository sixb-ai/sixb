import type { DuckLakeStorageOptions } from "../types"
import { getBigIntLike } from "./duckdb-row"
import type { DuckDbQueryRuntime } from "./duckdb-runtime"
import { encodeDatasetTableName } from "./names"
import { duckLakeMetadataTableName, quoteSqlString } from "./sql"

export interface DatasetTableRef {
  readonly datasetId: string
  readonly tableName: string
  readonly tableId: bigint
}

export async function resolveDatasetTableRef(
  options: DuckLakeStorageOptions,
  runtime: DuckDbQueryRuntime,
  datasetId: string
): Promise<DatasetTableRef | null> {
  const tableName = encodeDatasetTableName(datasetId)
  const ducklakeTable = duckLakeMetadataTableName(options, "ducklake_table")
  const [row] = await runtime.query(`
    SELECT table_id
    FROM ${ducklakeTable}
    WHERE table_name = ${quoteSqlString(tableName)}
      AND end_snapshot IS NULL
    LIMIT 1
  `)

  return row === undefined
    ? null
    : {
        datasetId,
        tableName,
        tableId: getBigIntLike(row, "table_id"),
      }
}
