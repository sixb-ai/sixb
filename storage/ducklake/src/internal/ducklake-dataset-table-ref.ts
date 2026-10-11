import { LakeStorageError } from "@sixb/core/lake-storage"
import type { DuckLakeStorageOptions } from "../types"
import { getBigIntLike } from "./duckdb-row"
import type { DuckDbQueryRuntime } from "./duckdb-runtime"
import { encodeDatasetSequenceTableName, encodeDatasetTableName } from "./names"
import { duckLakeAlias, duckLakeMetadataTableName, quoteIdentifier, quoteSqlString } from "./sql"

export interface DatasetTableRef {
  readonly datasetId: string
  readonly tableName: string
  readonly tableId: bigint
  /** The table a sequenced dataset keeps its source ordering in, which merges also change. */
  readonly sequenceTableId?: bigint
}

export async function resolveDatasetTableRef(
  options: DuckLakeStorageOptions,
  runtime: DuckDbQueryRuntime,
  datasetId: string
): Promise<DatasetTableRef | null> {
  return tableRefFromRows(datasetId, await runtime.query(datasetTablesSql(options, datasetId)))
}

/**
 * The dataset's tables and the lake's current snapshot, in one catalog read. Inside a
 * transaction, reading the current snapshot also fixes the transaction's DuckLake snapshot, which
 * DuckLake otherwise fixes on its first read of the lake.
 */
export async function resolveDatasetTableRefAtCurrentSnapshot(
  options: DuckLakeStorageOptions,
  runtime: DuckDbQueryRuntime,
  datasetId: string
): Promise<{ readonly snapshotId: string; readonly table: DatasetTableRef | null }> {
  // Joined on true, the current snapshot still reads when the dataset has no table.
  const rows = await runtime.query(`
    SELECT current.id AS current_snapshot, tables.table_id, tables.table_name
    FROM ${quoteIdentifier(duckLakeAlias(options))}.current_snapshot() current
    LEFT JOIN (${datasetTablesSql(options, datasetId)}) tables ON true
  `)
  const [first] = rows
  if (first === undefined) {
    throw new LakeStorageError("[SixbDuckLake] DuckLake did not return a current snapshot.")
  }

  return {
    snapshotId: String(getBigIntLike(first, "current_snapshot")),
    table: tableRefFromRows(
      datasetId,
      rows.filter((row) => row.table_id !== null && row.table_id !== undefined)
    ),
  }
}

/** Every table a dataset's versions change. */
export function datasetTableIds(table: Omit<DatasetTableRef, "tableName">): readonly bigint[] {
  return table.sequenceTableId === undefined
    ? [table.tableId]
    : [table.tableId, table.sequenceTableId]
}

function datasetTablesSql(options: DuckLakeStorageOptions, datasetId: string): string {
  const tableNames = [encodeDatasetTableName(datasetId), encodeDatasetSequenceTableName(datasetId)]
  return `
    SELECT table_id, table_name
    FROM ${duckLakeMetadataTableName(options, "ducklake_table")}
    WHERE table_name IN (${tableNames.map((name) => quoteSqlString(name)).join(", ")})
      AND end_snapshot IS NULL
  `
}

function tableRefFromRows(
  datasetId: string,
  rows: readonly Readonly<Record<string, unknown>>[]
): DatasetTableRef | null {
  const tableName = encodeDatasetTableName(datasetId)
  const tableIdOf = (name: string) => {
    const row = rows.find((candidate) => candidate.table_name === name)
    return row === undefined ? undefined : getBigIntLike(row, "table_id")
  }

  const tableId = tableIdOf(tableName)
  if (tableId === undefined) {
    return null
  }

  const sequenceTableId = tableIdOf(encodeDatasetSequenceTableName(datasetId))
  return {
    datasetId,
    tableName,
    tableId,
    ...(sequenceTableId === undefined ? {} : { sequenceTableId }),
  }
}
