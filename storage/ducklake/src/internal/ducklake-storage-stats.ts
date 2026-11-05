import type { DatasetDefinition } from "@sixb/core"
import type { DatasetStorageWarning } from "@sixb/core/lake-storage"
import type { DuckLakeStorageOptions } from "../types"
import { type DuckDbRow, getBigIntLike, getString } from "./duckdb-row"
import type { DuckDbQueryRuntime } from "./duckdb-runtime"
import { type DatasetTableRef, datasetTableIds } from "./ducklake-dataset-table-ref"
import { buildDuckLakeMetadataQuery, quoteIdentifier, quoteSqlString } from "./sql"

/**
 * A data file under this size is small: compaction merges small files together, and leaves
 * larger ones as they are, so no file is rewritten again and again as a dataset grows.
 */
export const SMALL_FILE_BYTES = 1024 * 1024

/** Compaction rewrites a data file once the rows its delete file removes reach this share. */
export const REWRITE_DELETED_SHARE = 0.1

/**
 * Below about this many rows, partitioning costs more than it saves: each write adds a file per
 * partition it touches, and compaction merges files only within one partition, so a small
 * dataset ends up as many tiny files that every read opens.
 */
export const PARTITIONED_DATASET_MIN_ROWS = 1_000_000

/** How one DuckLake table is stored now, from its catalog rows. */
export interface DuckLakeTableStorage {
  readonly dataFiles: number
  readonly smallDataFiles: number
  readonly dataBytes: number
  /** Rows the data files hold, deleted ones included. */
  readonly fileRows: number
  readonly deleteFiles: number
  /** Rows of data files that the delete files remove. */
  readonly deletedRows: number
  /** Data files whose deleted rows reached `REWRITE_DELETED_SHARE`. */
  readonly filesToRewrite: number
  /** Rows inlined in the catalog, the ones later replaced or deleted included. */
  readonly inlinedRows: number
  readonly liveInlinedRows: number
}

const EMPTY_TABLE_STORAGE: DuckLakeTableStorage = {
  dataFiles: 0,
  smallDataFiles: 0,
  dataBytes: 0,
  fileRows: 0,
  deleteFiles: 0,
  deletedRows: 0,
  filesToRewrite: 0,
  inlinedRows: 0,
  liveInlinedRows: 0,
}

/**
 * How each table of the datasets is stored, by table id, from at most three catalog queries
 * whatever the number of datasets. Every table is listed, an empty one with zero counts.
 *
 * Reads only current catalog rows: live data and delete files, and the inlined-data tables of
 * these tables. Never a data file, never the snapshot history.
 */
export async function readTableStorage(
  options: DuckLakeStorageOptions,
  runtime: DuckDbQueryRuntime,
  tables: readonly DatasetTableRef[]
): Promise<Map<bigint, DuckLakeTableStorage>> {
  const tableIds = tables.flatMap((table) => datasetTableIds(table))
  const storage = new Map(tableIds.map((tableId) => [tableId, { ...EMPTY_TABLE_STORAGE }]))
  if (tableIds.length === 0) {
    return storage
  }

  for (const row of await queryFiles(options, runtime, tableIds)) {
    const tableId = getBigIntLike(row, "table_id")
    storage.set(tableId, {
      ...EMPTY_TABLE_STORAGE,
      dataFiles: count(row, "data_files"),
      smallDataFiles: count(row, "small_data_files"),
      dataBytes: count(row, "data_bytes"),
      fileRows: count(row, "file_rows"),
      deleteFiles: count(row, "delete_files"),
      deletedRows: count(row, "deleted_rows"),
      filesToRewrite: count(row, "files_to_rewrite"),
    })
  }

  for (const row of await queryInlinedRows(options, runtime, tableIds)) {
    const tableId = getBigIntLike(row, "table_id")
    const table = storage.get(tableId) ?? EMPTY_TABLE_STORAGE
    storage.set(tableId, {
      ...table,
      inlinedRows: table.inlinedRows + count(row, "inlined_rows"),
      liveInlinedRows: table.liveInlinedRows + count(row, "live_inlined_rows"),
    })
  }

  return storage
}

/** Live data files of the tables, each with the delete file that marks some of its rows deleted. */
async function queryFiles(
  options: DuckLakeStorageOptions,
  runtime: DuckDbQueryRuntime,
  tableIds: readonly bigint[]
): Promise<readonly DuckDbRow[]> {
  return runtime.query(
    buildDuckLakeMetadataQuery(
      options,
      (table) => `
        SELECT
          file.table_id,
          CAST(count(*) AS BIGINT) AS data_files,
          CAST(count(*) FILTER (WHERE file.file_size_bytes < ${SMALL_FILE_BYTES}) AS BIGINT)
            AS small_data_files,
          CAST(coalesce(sum(file.file_size_bytes), 0) AS BIGINT) AS data_bytes,
          CAST(coalesce(sum(file.record_count), 0) AS BIGINT) AS file_rows,
          CAST(count(deletes.delete_file_id) AS BIGINT) AS delete_files,
          CAST(coalesce(sum(deletes.delete_count), 0) AS BIGINT) AS deleted_rows,
          CAST(
            count(*) FILTER (
              WHERE deletes.delete_count >= file.record_count * ${REWRITE_DELETED_SHARE}
            ) AS BIGINT
          ) AS files_to_rewrite
        FROM ${table("ducklake_data_file")} file
        LEFT JOIN ${table("ducklake_delete_file")} deletes
          ON deletes.data_file_id = file.data_file_id AND deletes.end_snapshot IS NULL
        WHERE file.end_snapshot IS NULL AND file.table_id IN (${tableIds.join(", ")})
        GROUP BY file.table_id
      `
    )
  )
}

/**
 * Inlined rows of the tables. DuckLake keeps them in one catalog table per table and schema
 * version, listed in `ducklake_inlined_data_tables`, until a flush moves them to a file.
 */
async function queryInlinedRows(
  options: DuckLakeStorageOptions,
  runtime: DuckDbQueryRuntime,
  tableIds: readonly bigint[]
): Promise<readonly DuckDbRow[]> {
  const inlinedTables = await runtime.query(
    buildDuckLakeMetadataQuery(
      options,
      (table) => `
        SELECT table_id, table_name
        FROM ${table("ducklake_inlined_data_tables")}
        WHERE table_id IN (${tableIds.join(", ")})
      `
    )
  )
  if (inlinedTables.length === 0) {
    return []
  }

  return runtime.query(
    buildDuckLakeMetadataQuery(options, (table) =>
      inlinedTables
        .map(
          (inlined) => `
            SELECT
              ${getBigIntLike(inlined, "table_id")} AS table_id,
              CAST(count(*) AS BIGINT) AS inlined_rows,
              CAST(count(*) FILTER (WHERE end_snapshot IS NULL) AS BIGINT) AS live_inlined_rows
            FROM ${table(getString(inlined, "table_name"))}
          `
        )
        .join(" UNION ALL ")
    )
  )
}

/**
 * How many snapshots still in the catalog changed one of each dataset's tables: its versions and
 * the maintenance of its files. One scan of the snapshot changes for every dataset.
 */
export async function countRetainedSnapshots(
  options: DuckLakeStorageOptions,
  runtime: DuckDbQueryRuntime,
  tables: readonly DatasetTableRef[]
): Promise<Map<string, number>> {
  if (tables.length === 0) {
    return new Map()
  }

  const counts = tables.map((dataset, index) => {
    const namesTable = datasetTableIds(dataset)
      .map((tableId) => `strpos(',' || changes_made || ',', ${quoteSqlString(`:${tableId},`)}) > 0`)
      .join(" OR ")
    return `CAST(count(*) FILTER (WHERE ${namesTable}) AS BIGINT) AS ${quoteIdentifier(`d${index}`)}`
  })

  const [row] = await runtime.query(
    buildDuckLakeMetadataQuery(
      options,
      (table) => `SELECT ${counts.join(", ")} FROM ${table("ducklake_snapshot_changes")}`
    )
  )

  return new Map(tables.map((dataset, index) => [dataset.datasetId, count(row, `d${index}`)]))
}

/** The rows a table holds now: its file rows not deleted, and its live inlined rows. */
export function tableRowCount(table: DuckLakeTableStorage): number {
  return table.fileRows - table.deletedRows + table.liveInlinedRows
}

/** What a partitioned dataset holding too few rows to benefit from it should hear. */
export function partitionWarnings(
  definition: DatasetDefinition | undefined,
  rowCount: number
): readonly DatasetStorageWarning[] {
  const partitionBy = definition?.partitionBy ?? []
  if (partitionBy.length === 0 || rowCount >= PARTITIONED_DATASET_MIN_ROWS) {
    return []
  }

  return [
    {
      code: "partitioned-small-dataset",
      message: `Dataset '${definition?.id}' is partitioned by ${partitionBy.join(", ")} but holds ${rowCount} row${rowCount === 1 ? "" : "s"}. Below about ${PARTITIONED_DATASET_MIN_ROWS.toLocaleString("en-US")} rows, partitioning only multiplies small files: each write adds one per partition it touches, and compaction merges files within a partition only. Remove partitionBy.`,
    },
  ]
}

function count(row: DuckDbRow | undefined, key: string): number {
  return row === undefined ? 0 : Number(getBigIntLike(row, key))
}
