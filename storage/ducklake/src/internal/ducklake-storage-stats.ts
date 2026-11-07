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

/** Compaction rewrites a data file once its deleted rows reach this share. */
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
  /**
   * Rows of data files deleted since they were written: by their delete files, or in the catalog,
   * where DuckLake keeps a small write's deletes until a flush moves them to a delete file.
   */
  readonly deletedRows: number
  /** Data files whose deleted rows reached `REWRITE_DELETED_SHARE`. */
  readonly filesToRewrite: number
  /** Rows inlined in the catalog, the ones later replaced or deleted included. */
  readonly inlinedRows: number
  readonly liveInlinedRows: number
  /** The part of `deletedRows` the catalog holds. */
  readonly inlinedDeletes: number
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
  inlinedDeletes: 0,
}

/**
 * How each table of the datasets is stored, by table id, from at most four catalog queries
 * whatever the number of datasets, and on a local catalog one probe per table besides (see
 * `findInlinedDeleteTables`). Every table is listed, an empty one with zero counts.
 *
 * Reads only current catalog rows: live data and delete files, and the inlined-data and
 * inlined-delete tables of these tables. Never a data file, never the snapshot history.
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

  const inlinedDeletes = await findInlinedDeleteTables(options, runtime, tableIds)
  for (const row of await queryFiles(options, runtime, tableIds, inlinedDeletes)) {
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
      inlinedDeletes: count(row, "inlined_deletes"),
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

/**
 * Live data files of the tables, each with its deleted rows: those of the delete file that marks
 * some of them deleted, and those deleted in the catalog. The two never overlap: a flush moves a
 * file's deletes from the catalog into a new delete file that holds both.
 */
async function queryFiles(
  options: DuckLakeStorageOptions,
  runtime: DuckDbQueryRuntime,
  tableIds: readonly bigint[],
  inlinedDeletes: readonly bigint[]
): Promise<readonly DuckDbRow[]> {
  const inlinedCount = inlinedDeletes.length === 0 ? "0" : "coalesce(inlined.delete_count, 0)"
  const deleted = `coalesce(deletes.delete_count, 0) + ${inlinedCount}`

  return runtime.query(
    buildDuckLakeMetadataQuery(options, (table) => {
      // An inlined delete can name a file a rewrite has since replaced: the join leaves it out.
      const inlined =
        inlinedDeletes.length === 0
          ? ""
          : `
            LEFT JOIN (
              ${inlinedDeletes
                .map(
                  (tableId) => `
                    SELECT ${tableId} AS table_id, file_id, count(*) AS delete_count
                    FROM ${table(inlinedDeleteTableName(tableId))}
                    GROUP BY file_id
                  `
                )
                .join(" UNION ALL ")}
            ) inlined
              ON inlined.table_id = file.table_id AND inlined.file_id = file.data_file_id
          `

      return `
        SELECT
          file.table_id,
          CAST(count(*) AS BIGINT) AS data_files,
          CAST(count(*) FILTER (WHERE file.file_size_bytes < ${SMALL_FILE_BYTES}) AS BIGINT)
            AS small_data_files,
          CAST(coalesce(sum(file.file_size_bytes), 0) AS BIGINT) AS data_bytes,
          CAST(coalesce(sum(file.record_count), 0) AS BIGINT) AS file_rows,
          CAST(count(deletes.delete_file_id) AS BIGINT) AS delete_files,
          CAST(coalesce(sum(${deleted}), 0) AS BIGINT) AS deleted_rows,
          CAST(coalesce(sum(${inlinedCount}), 0) AS BIGINT) AS inlined_deletes,
          CAST(
            count(*) FILTER (
              WHERE ${deleted} > 0 AND ${deleted} >= file.record_count * ${REWRITE_DELETED_SHARE}
            ) AS BIGINT
          ) AS files_to_rewrite
        FROM ${table("ducklake_data_file")} file
        LEFT JOIN ${table("ducklake_delete_file")} deletes
          ON deletes.data_file_id = file.data_file_id AND deletes.end_snapshot IS NULL
        ${inlined}
        WHERE file.end_snapshot IS NULL AND file.table_id IN (${tableIds.join(", ")})
        GROUP BY file.table_id
      `
    })
  )
}

/**
 * The tables among these that have an inlined-delete table. A write deleting few rows of a data
 * file keeps those deletes in the catalog, in one table per table, which DuckLake creates at the
 * table's first such delete and lists nowhere.
 *
 * PostgreSQL says which exist, in one query. DuckDB hides a local catalog from its table
 * listings, so there each table is probed, as DuckLake itself does: a local lookup, no round trip.
 */
async function findInlinedDeleteTables(
  options: DuckLakeStorageOptions,
  runtime: DuckDbQueryRuntime,
  tableIds: readonly bigint[]
): Promise<readonly bigint[]> {
  if (options.catalog.type === "postgres") {
    const rows = await runtime.query(
      buildDuckLakeMetadataQuery(options, (table) => {
        const candidates = tableIds.map(
          (tableId) => `(${tableId}, ${quoteSqlString(table(inlinedDeleteTableName(tableId)))})`
        )

        return `
          SELECT CAST(table_id AS BIGINT) AS table_id
          FROM (VALUES ${candidates.join(", ")}) AS candidate(table_id, table_name)
          WHERE to_regclass(table_name) IS NOT NULL
        `
      })
    )
    return rows.map((row) => getBigIntLike(row, "table_id"))
  }

  const found: bigint[] = []
  for (const tableId of tableIds) {
    const tableName = inlinedDeleteTableName(tableId)

    try {
      await runtime.query(
        buildDuckLakeMetadataQuery(
          options,
          (table) => `SELECT NULL FROM ${table(tableName)} LIMIT 1`
        )
      )
      found.push(tableId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes(`${tableName} does not exist`)) {
        throw error
      }
    }
  }

  return found
}

function inlinedDeleteTableName(tableId: bigint): string {
  return `ducklake_inlined_delete_${tableId}`
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
