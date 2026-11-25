import { randomBytes } from "node:crypto"
import { rm } from "node:fs/promises"
import type { DatasetProducer } from "@sixb/core/lake-storage"
import { LakeStorageError } from "@sixb/core/lake-storage"
import type { DuckLakeStorageOptions } from "../types"
import { getBigIntLike, getOptionalString, getString } from "./duckdb-row"
import type { DuckDbQueryRuntime } from "./duckdb-runtime"
import { findInlinedDeleteTables } from "./ducklake-storage-stats"
import { COPIES_PREFIX, type LakeFiles } from "./lake-files"
import { sliceCommitInfo } from "./slice-commits"
import { writeCopy } from "./slice-copies"
import {
  buildDuckLakeMetadataQuery,
  duckLakeMetadataTableName,
  qualifiedTableName,
  quoteIdentifier,
  quoteSqlString,
} from "./sql"
import { BRANCH_SNAPSHOT_BASE } from "./versions"

/**
 * The host a slice names production's files under. It never resolves (`.invalid` is reserved):
 * a branch reads them through its loopback proxy, which DuckDB reaches with a scoped HTTP secret.
 * The catalog names no production URL and holds no credential.
 */
export const PRODUCTION_FILES_ROOT = "http://sixb-production-lake.invalid/"

/** A table of the slice: a dataset's own table or its source-ordering table, at its version. */
export interface SliceTable {
  readonly tableId: bigint
  readonly tableName: string
  /** The snapshot of the dataset's version the slice holds. */
  readonly snapshotId: bigint
  readonly datasetId: string
  /** The version's producer, as its reader sees it. */
  readonly producer?: DatasetProducer
  /**
   * Set on a dataset's source-ordering table. A row of it without `content` is a tombstone: the
   * key of a row deleted from the dataset, which its version no longer returns. The slice keeps
   * the live keys only, which a branch's sequenced merges still order against.
   */
  readonly withoutTombstones?: true
}

/** The rows of a source-ordering table that are not tombstones. */
const LIVE_KEYS = `${quoteIdentifier("content")} IS NOT NULL`

/** The condition a table's rows meet in the slice, besides being live at its snapshot. */
function keptRows(table: SliceTable): string | undefined {
  return table.withoutTombstones ? LIVE_KEYS : undefined
}

export interface WriteCatalogSliceInput {
  readonly tables: readonly SliceTable[]
  /** The point the slice is cut at. Its snapshot closes the slice's history. */
  readonly pointSnapshotId: bigint
  readonly path: string
  /** Records the files the slice serves, before the cut writes any copy. */
  readonly record: (files: ReadonlySet<string>) => Promise<void>
}

/** A data file a slice reads, at its table's snapshot. */
interface SliceFile {
  readonly tableId: bigint
  readonly dataFileId: bigint
  /** Where production's DuckDB reads it. */
  readonly location: string
  /** The path the route serves it under: in the data path, or a copy without deleted rows. */
  readonly path: string
  /**
   * Set when the slice holds part of its rows: some are deleted at the snapshot, written after it,
   * or tombstones. The copy that leaves them out.
   */
  readonly copy?: string
  readonly rowIdStart: bigint | null
  readonly recordCount: bigint
}

// Every table of a DuckLake catalog the slice knows how to cut, besides the inlined ones. A
// DuckLake build that adds a table must be taught here first: a slice that left one out could
// lose what it holds.
const CATALOG_TABLES = new Set([
  "ducklake_column",
  "ducklake_column_mapping",
  "ducklake_column_tag",
  "ducklake_data_file",
  "ducklake_delete_file",
  "ducklake_file_column_stats",
  "ducklake_file_partition_value",
  "ducklake_file_variant_stats",
  "ducklake_files_scheduled_for_deletion",
  "ducklake_inlined_data_tables",
  "ducklake_macro",
  "ducklake_macro_impl",
  "ducklake_macro_parameters",
  "ducklake_metadata",
  "ducklake_name_mapping",
  "ducklake_partition_column",
  "ducklake_partition_info",
  "ducklake_schema",
  "ducklake_schema_versions",
  "ducklake_snapshot",
  "ducklake_snapshot_changes",
  "ducklake_sort_expression",
  "ducklake_sort_info",
  "ducklake_table",
  "ducklake_table_column_stats",
  "ducklake_table_stats",
  "ducklake_tag",
  "ducklake_view",
])

/** The inlined-table families the slice knows: rows per schema version, and deletes per table. */
const INLINED_TABLE = /^ducklake_inlined_(data_\d+_\d+|data_tables|delete_\d+)$/

/**
 * Writes a DuckDB-file DuckLake catalog holding only `tables`, each as of its snapshot, to
 * `path`, from one transaction of `runtime`: one state of production's catalog, whatever commits,
 * flushes or expiries land meanwhile. Production's metadata is read, never written.
 *
 * - Rows live at a table's snapshot are kept and end there no more; later rows are left out.
 * - A data file none of whose rows are deleted is named under `PRODUCTION_FILES_ROOT`, with its
 *   stats. One with deleted rows, in a delete file or in the catalog, is served as a copy without
 *   them (`slice-copies.ts`): the branch can read a file whole, so it never receives a row its
 *   version does not return. The slice holds no delete file, and no stats of values production
 *   can no longer return.
 * - Inlined rows are decoded through DuckLake: a PostgreSQL catalog stores them encoded, and the
 *   slice stores them as a DuckDB catalog does.
 * - A source-ordering table keeps no tombstone (`withoutTombstones`): a file holding one is served
 *   as a copy without it, and inlined ones are left out.
 * - Snapshots: those of the versions, with their commit metadata as their reader sees it, and the
 *   point's own, with no change of its own.
 * - Nothing else: no other table, view, macro, file scheduled for deletion, or commit.
 *
 * Each table's rows are counted at the end, against production's version: a slice that holds
 * other rows is deleted, never attached. DuckLake reads a version through its own metadata
 * connections, outside the transaction: a version another process expires mid-cut fails those
 * reads, and the cut with them.
 */
export async function writeCatalogSlice(
  options: DuckLakeStorageOptions,
  runtime: DuckDbQueryRuntime,
  files: LakeFiles,
  input: WriteCatalogSliceInput
): Promise<ReadonlySet<string>> {
  const slice = `sixb_slice_${randomBytes(6).toString("hex")}`
  const meta = (table: string) => duckLakeMetadataTableName(options, table)
  const into = (table: string) => `${quoteIdentifier(slice)}.${quoteIdentifier(table)}`

  await assertKnownInlinedTables(options, runtime)
  await createEmptyCatalog(runtime, input.path, slice)

  let served: ReadonlySet<string> = new Set()
  try {
    await assertKnownCatalogTables(runtime, slice)
    await runtime.run("BEGIN TRANSACTION")

    await runtime.run(`
      INSERT INTO ${into("ducklake_metadata")} BY NAME
      SELECT * FROM ${meta("ducklake_metadata")}
      WHERE scope IS NULL AND key IN ('version', 'created_by', 'encrypted')
    `)
    await runtime.run(
      `INSERT INTO ${into("ducklake_metadata")} VALUES ('data_path', ${quoteSqlString(PRODUCTION_FILES_ROOT)}, NULL, NULL)`
    )
    await copySnapshots(runtime, meta, into, input)

    const live = input.tables.length > 0 ? await liveFiles(options, runtime, input.tables) : []
    served = new Set(live.map((file) => file.path))
    await input.record(served)

    if (input.tables.length > 0) {
      await copyTables(options, runtime, { meta, into, files, input, live })
      await assertRowCounts(options, runtime, into, input.tables)
    }

    await runtime.run("COMMIT")
  } catch (error) {
    // A slice that holds part of what it should must never be attached.
    await runtime.run("ROLLBACK").catch(() => undefined)
    await runtime.run(`DETACH ${quoteIdentifier(slice)}`).catch(() => undefined)
    await rm(input.path, { force: true })
    await rm(`${input.path}.wal`, { force: true })
    if (error instanceof LakeStorageError) throw error
    throw new LakeStorageError(
      `[SixbDuckLake] The slice could not be cut, and nothing of it was kept: ${error instanceof Error ? error.message : String(error)}. Cut the slice again.`,
      { cause: error }
    )
  }

  await runtime.run(`DETACH ${quoteIdentifier(slice)}`)
  return served
}

/** The catalog's data path, which every relative file path is under, ending with "/". */
export async function catalogDataPath(
  options: DuckLakeStorageOptions,
  runtime: DuckDbQueryRuntime
): Promise<string> {
  const [row] = await runtime.query(
    `SELECT value FROM ${duckLakeMetadataTableName(options, "ducklake_metadata")} WHERE key = 'data_path' AND scope IS NULL`
  )
  const value = row === undefined ? undefined : getOptionalString(row, "value")
  if (!value) throw new LakeStorageError("[SixbDuckLake] The lake's catalog names no data path.")
  return value.endsWith("/") ? value : `${value}/`
}

/** Everything the slice holds of its tables, as of each one's snapshot. */
async function copyTables(
  options: DuckLakeStorageOptions,
  runtime: DuckDbQueryRuntime,
  context: {
    readonly meta: (table: string) => string
    readonly into: (table: string) => string
    readonly files: LakeFiles
    readonly input: WriteCatalogSliceInput
    readonly live: readonly SliceFile[]
  }
): Promise<void> {
  const { meta, into, input } = context
  const live = liveAt(input.tables)

  for (const table of ["ducklake_table", "ducklake_column", "ducklake_column_tag"]) {
    await runtime.run(live.insert(into(table), meta(table)))
  }
  await runtime.run(live.insert(into("ducklake_tag"), meta("ducklake_tag"), "object_id"))
  await runtime.run(`
    INSERT INTO ${into("ducklake_schema")} BY NAME
    SELECT * REPLACE (NULL::BIGINT AS end_snapshot) FROM ${meta("ducklake_schema")}
    WHERE schema_id IN (SELECT schema_id FROM ${into("ducklake_table")})
      AND begin_snapshot <= ${input.pointSnapshotId}
      AND (end_snapshot IS NULL OR end_snapshot > ${input.pointSnapshotId})
  `)
  await runtime.run(`
    INSERT INTO ${into("ducklake_schema_versions")} BY NAME
    SELECT * FROM ${meta("ducklake_schema_versions")}
    WHERE table_id IN (${live.ids}) AND begin_snapshot <= ${input.pointSnapshotId}
  `)

  for (const [table, child, key] of [
    ["ducklake_partition_info", "ducklake_partition_column", "partition_id"],
    ["ducklake_sort_info", "ducklake_sort_expression", "sort_id"],
  ] as const) {
    await runtime.run(live.insert(into(table), meta(table)))
    await runtime.run(byParent(into(child), meta(child), key, into(table)))
  }

  await copyFiles(options, runtime, context)
  await copyInlinedRows(options, runtime, meta, into, input.tables)

  // Table stats as the slice holds them. Production's column stats span values written after the
  // point and values deleted since, so the slice keeps none.
  await runtime.run(`
    INSERT INTO ${into("ducklake_table_stats")}
    SELECT stats.table_id, coalesce(files.records, 0), stats.next_row_id, coalesce(files.bytes, 0)
    FROM ${meta("ducklake_table_stats")} stats
    LEFT JOIN (
      SELECT table_id, sum(record_count) AS records, sum(file_size_bytes) AS bytes
      FROM ${into("ducklake_data_file")} GROUP BY table_id
    ) files ON files.table_id = stats.table_id
    WHERE stats.table_id IN (${live.ids})
  `)
}

async function copySnapshots(
  runtime: DuckDbQueryRuntime,
  meta: (table: string) => string,
  into: (table: string) => string,
  input: WriteCatalogSliceInput
): Promise<void> {
  const versions = [...new Set(input.tables.map((table) => table.snapshotId))]
  const kept = [...new Set([...versions, input.pointSnapshotId])]

  await runtime.run(`
    INSERT INTO ${into("ducklake_snapshot")} BY NAME
    SELECT * FROM ${meta("ducklake_snapshot")} WHERE snapshot_id IN (${kept.join(", ")})
  `)

  // A version's commit names only the slice's tables, and says what its reader sees.
  const tableIds = new Set(input.tables.map((table) => table.tableId.toString()))
  const datasetIds = new Set(input.tables.map((table) => table.datasetId))
  const changes =
    versions.length === 0
      ? []
      : await runtime.query(`
          SELECT snapshot_id, changes_made, author, commit_message, commit_extra_info
          FROM ${meta("ducklake_snapshot_changes")} WHERE snapshot_id IN (${versions.join(", ")})
        `)
  for (const row of changes) {
    const snapshotId = getBigIntLike(row, "snapshot_id")
    const table = input.tables.find((candidate) => candidate.snapshotId === snapshotId)
    const changesMade = getString(row, "changes_made")
      .split(",")
      .filter((change) => tableIds.has(change.slice(change.indexOf(":") + 1)))
      .join(",")
    const info = sliceCommitInfo(getOptionalString(row, "commit_extra_info"), {
      datasetIds,
      producer: table?.producer,
    })

    await runtime.run(
      `INSERT INTO ${into("ducklake_snapshot_changes")} VALUES (${[
        snapshotId.toString(),
        quoteSqlString(changesMade),
        // Free text, such as a pipeline's run and step: a branch's reader may see none of it.
        "NULL",
        "NULL",
        sqlStringOrNull(info),
      ].join(", ")})`
    )
  }

  // The point closes production's history in the slice. It may be another dataset's commit, so it
  // carries none of production's.
  if (!versions.includes(input.pointSnapshotId)) {
    await runtime.run(
      `INSERT INTO ${into("ducklake_snapshot_changes")} VALUES (${input.pointSnapshotId}, '', NULL, NULL, NULL)`
    )
  }

  // The branch's history starts above production's: its first commit is BRANCH_SNAPSHOT_BASE + 1,
  // so its version ids carry the branch's marker (`versions.ts`).
  await runtime.run(`
    INSERT INTO ${into("ducklake_snapshot")}
    SELECT ${BRANCH_SNAPSHOT_BASE}, snapshot_time, schema_version, next_catalog_id, next_file_id
    FROM ${into("ducklake_snapshot")} WHERE snapshot_id = ${input.pointSnapshotId}
  `)
  await runtime.run(
    `INSERT INTO ${into("ducklake_snapshot_changes")} VALUES (${BRANCH_SNAPSHOT_BASE}, '', NULL, NULL, NULL)`
  )
}

async function copyFiles(
  options: DuckLakeStorageOptions,
  runtime: DuckDbQueryRuntime,
  context: {
    readonly meta: (table: string) => string
    readonly into: (table: string) => string
    readonly files: LakeFiles
    readonly input: WriteCatalogSliceInput
    readonly live: readonly SliceFile[]
  }
): Promise<void> {
  const { meta, into, files, input, live } = context
  const whole = live.filter((file) => file.copy === undefined)
  const deleted = live.filter((file) => file.copy !== undefined)
  const ids = (list: readonly SliceFile[]) =>
    list.length === 0 ? "NULL" : list.map((file) => file.dataFileId).join(", ")

  // Files none of whose rows are deleted: production's own, with their stats.
  await runtime.run(`
    INSERT INTO ${into("ducklake_data_file")} BY NAME
    SELECT f.* REPLACE (
      NULL::BIGINT AS end_snapshot,
      ${quoteSqlString(PRODUCTION_FILES_ROOT)} || paths.path AS path,
      false AS path_is_relative
    )
    FROM ${meta("ducklake_data_file")} f
    JOIN (VALUES ${whole.length === 0 ? "(NULL::BIGINT, NULL::VARCHAR)" : whole.map((file) => `(${file.dataFileId}, ${quoteSqlString(encodeServedPath(file.path))})`).join(", ")}) AS paths(data_file_id, path)
      ON paths.data_file_id = f.data_file_id
    WHERE f.table_id IN (${liveAt(input.tables).ids})
  `)
  for (const table of ["ducklake_file_column_stats", "ducklake_file_variant_stats"]) {
    await runtime.run(
      `INSERT INTO ${into(table)} BY NAME SELECT * FROM ${meta(table)} WHERE data_file_id IN (${ids(whole)})`
    )
  }
  await runtime.run(`
    INSERT INTO ${into("ducklake_column_mapping")} BY NAME
    SELECT * FROM ${meta("ducklake_column_mapping")}
    WHERE mapping_id IN (SELECT mapping_id FROM ${into("ducklake_data_file")})
  `)
  await runtime.run(
    byParent(
      into("ducklake_name_mapping"),
      meta("ducklake_name_mapping"),
      "mapping_id",
      into("ducklake_column_mapping")
    )
  )

  // Files with deleted rows: a copy without them, which carries its rows' ids.
  if (deleted.length > 0) {
    await assertUnencrypted(runtime, meta)
    await files.prepareCopies()
  }
  for (const file of deleted) {
    const table = input.tables.find((candidate) => candidate.tableId === file.tableId)
    if (!table || file.copy === undefined) continue

    const kept = keptRows(table)
    const copy = await writeCopy(options, runtime, files, {
      table,
      location: file.location,
      rowIdStart: file.rowIdStart,
      recordCount: file.recordCount,
      dataFileId: file.dataFileId,
      name: file.copy,
      ...(kept === undefined ? {} : { where: kept }),
    })
    await runtime.run(`
      INSERT INTO ${into("ducklake_data_file")} BY NAME
      SELECT f.* REPLACE (
        NULL::BIGINT AS end_snapshot,
        ${quoteSqlString(`${PRODUCTION_FILES_ROOT}${COPIES_PREFIX}${file.copy}`)} AS path,
        false AS path_is_relative,
        ${copy.rows}::BIGINT AS record_count,
        ${copy.bytes}::BIGINT AS file_size_bytes,
        NULL::BIGINT AS footer_size,
        NULL::BIGINT AS row_id_start,
        NULL::BIGINT AS mapping_id,
        NULL::BIGINT AS partial_max
      )
      FROM ${meta("ducklake_data_file")} f WHERE f.data_file_id = ${file.dataFileId}
    `)
  }

  await runtime.run(
    `INSERT INTO ${into("ducklake_file_partition_value")} BY NAME SELECT * FROM ${meta("ducklake_file_partition_value")} WHERE data_file_id IN (${ids(live)})`
  )
}

/**
 * Inlined rows live at each table's snapshot. They are read back through DuckLake by row id,
 * which prunes every file by its row-id range, so decoding them reads no data file. Inlined
 * deletes are not copied: the files they delete from are served as copies without those rows.
 * Tombstones are left out once decoded: a PostgreSQL catalog stores `content` encoded.
 */
async function copyInlinedRows(
  options: DuckLakeStorageOptions,
  runtime: DuckDbQueryRuntime,
  meta: (table: string) => string,
  into: (table: string) => string,
  tables: readonly SliceTable[]
): Promise<void> {
  const byId = new Map(tables.map((table) => [table.tableId.toString(), table]))
  const inlined = await runtime.query(`
    SELECT table_id, table_name, schema_version FROM ${meta("ducklake_inlined_data_tables")}
    WHERE table_id IN (${[...byId.keys()].join(", ")})
  `)

  for (const row of inlined) {
    const table = byId.get(getBigIntLike(row, "table_id").toString())
    if (!table) continue

    const name = getString(row, "table_name")
    const columns = (await runtime.query(`DESCRIBE ${meta(name)}`))
      .map((column) => getString(column, "column_name"))
      .filter((column) => !["row_id", "begin_snapshot", "end_snapshot"].includes(column))
    const liveRows = `
      SELECT row_id, begin_snapshot FROM ${meta(name)}
      WHERE begin_snapshot <= ${table.snapshotId}
        AND (end_snapshot IS NULL OR end_snapshot > ${table.snapshotId})
    `
    const rowIds = (await runtime.query(liveRows)).map((live) => getBigIntLike(live, "row_id"))
    const relation = `${qualifiedTableName(options, table.tableName)} AT (VERSION => ${table.snapshotId})`
    const quoted = columns.map((column) => quoteIdentifier(column))
    const kept = keptRows(table)

    await runtime.run(`
      CREATE TABLE ${into(name)} AS
      SELECT
        live.row_id::BIGINT AS row_id,
        live.begin_snapshot::BIGINT AS begin_snapshot,
        NULL::BIGINT AS end_snapshot,
        ${quoted.map((column) => `decoded.${column}`).join(", ")}
      FROM (${liveRows}) live
      JOIN (
        SELECT rowid AS sixb_row_id, ${quoted.join(", ")} FROM ${relation}
        WHERE rowid IN (${rowIds.length === 0 ? "NULL" : rowIds.join(", ")})
          ${kept === undefined ? "" : `AND ${kept}`}
      ) decoded ON decoded.sixb_row_id = live.row_id
    `)
    await runtime.run(
      `INSERT INTO ${into("ducklake_inlined_data_tables")} VALUES (${table.tableId}, ${quoteSqlString(name)}, ${getBigIntLike(row, "schema_version")})`
    )
  }
}

/**
 * The data files each table reads at its snapshot, and whether any of their rows are deleted
 * there, by a delete file or in the catalog, whether it holds rows of later commits (a file
 * compaction merged), or tombstones the slice leaves out. A copy is named by the table's uuid, the
 * file and the snapshot: what a file holds at a snapshot never changes, whatever compaction does
 * to it later, so every slice of that version shares it, and a lake created again never reuses a
 * name. A copy without tombstones has a name of its own: one cut before slices left them out
 * holds them, and is never reused for one that must not.
 */
async function liveFiles(
  options: DuckLakeStorageOptions,
  runtime: DuckDbQueryRuntime,
  tables: readonly SliceTable[]
): Promise<SliceFile[]> {
  const meta = (table: string) => duckLakeMetadataTableName(options, table)
  const dataPath = await catalogDataPath(options, runtime)
  const live = liveAt(tables)

  const rows = await runtime.query(
    live.select(
      `f.table_id, f.data_file_id, f.row_id_start, f.record_count, f.partial_max,
       t.table_uuid, sixb_cut.cut_snapshot,
       ${locationSql(dataPath)} AS location`,
      meta("ducklake_data_file"),
      "f",
      { joins: filePathJoins(meta) }
    )
  )

  const deleted = new Set<string>()
  for (const row of await runtime.query(
    live.select("live.data_file_id", meta("ducklake_delete_file"), "live")
  )) {
    deleted.add(getBigIntLike(row, "data_file_id").toString())
  }
  for (const tableId of await findInlinedDeleteTables(
    options,
    runtime,
    tables.map((table) => table.tableId)
  )) {
    const table = tables.find((candidate) => candidate.tableId === tableId)
    if (!table) continue

    for (const row of await runtime.query(`
      SELECT DISTINCT file_id FROM ${meta(`ducklake_inlined_delete_${tableId}`)}
      WHERE begin_snapshot <= ${table.snapshotId}
    `)) {
      deleted.add(getBigIntLike(row, "file_id").toString())
    }
  }

  const tombstoned = await filesWithTombstones(meta, runtime, tables)

  return rows.map((row) => {
    const tableId = getBigIntLike(row, "table_id")
    const table = tables.find((candidate) => candidate.tableId === tableId)
    const dataFileId = getBigIntLike(row, "data_file_id")
    const location = getString(row, "location")
    if (!location.startsWith(dataPath)) {
      throw new LakeStorageError(
        `[SixbDuckLake] A dataset reads '${location}', outside the lake's data path '${dataPath}'. A branch reads only files under it.`
      )
    }

    // Compaction merges files written by later commits into one: such a file holds rows the
    // version does not return, up to its `partial_max` snapshot.
    const cut = getBigIntLike(row, "cut_snapshot")
    const partial =
      row.partial_max !== null &&
      row.partial_max !== undefined &&
      getBigIntLike(row, "partial_max") > cut
    const copy =
      deleted.has(dataFileId.toString()) || partial || tombstoned.has(dataFileId.toString())
        ? `${getString(row, "table_uuid")}-${dataFileId}-${cut}${table?.withoutTombstones ? "-live-keys" : ""}.parquet`
        : undefined
    return {
      tableId,
      dataFileId,
      location,
      path: copy === undefined ? location.slice(dataPath.length) : `${COPIES_PREFIX}${copy}`,
      ...(copy === undefined ? {} : { copy }),
      rowIdStart:
        row.row_id_start === null || row.row_id_start === undefined
          ? null
          : getBigIntLike(row, "row_id_start"),
      recordCount: getBigIntLike(row, "record_count"),
    }
  })
}

/**
 * The files of source-ordering tables that may hold a tombstone at their snapshot: every one
 * whose stats do not count `content` as never null.
 */
async function filesWithTombstones(
  meta: (table: string) => string,
  runtime: DuckDbQueryRuntime,
  tables: readonly SliceTable[]
): Promise<ReadonlySet<string>> {
  const ordering = tables.filter((table) => table.withoutTombstones)
  if (ordering.length === 0) return new Set()

  const rows = await runtime.query(
    liveAt(ordering).select("f.data_file_id", meta("ducklake_data_file"), "f", {
      joins: `
        LEFT JOIN ${meta("ducklake_column")} c
          ON c.table_id = f.table_id AND c.column_name = 'content' AND c.end_snapshot IS NULL
        LEFT JOIN ${meta("ducklake_file_column_stats")} stats
          ON stats.data_file_id = f.data_file_id AND stats.column_id = c.column_id
      `,
      where: "coalesce(stats.null_count, 1) > 0",
    })
  )
  return new Set(rows.map((row) => getBigIntLike(row, "data_file_id").toString()))
}

/**
 * Counts each table's rows in the slice against production's version, in the cut's transaction.
 * The slice holds no deletes, so its files' record counts and its inlined rows are its rows.
 */
async function assertRowCounts(
  options: DuckLakeStorageOptions,
  runtime: DuckDbQueryRuntime,
  into: (table: string) => string,
  tables: readonly SliceTable[]
): Promise<void> {
  const inlinedTables = await runtime.query(
    `SELECT table_id, table_name FROM ${into("ducklake_inlined_data_tables")}`
  )

  for (const table of tables) {
    const kept = keptRows(table)
    const [expected] = await runtime.query(
      `SELECT count(*) AS rows FROM ${qualifiedTableName(options, table.tableName)} AT (VERSION => ${table.snapshotId}) ${kept === undefined ? "" : `WHERE ${kept}`}`
    )
    const [files] = await runtime.query(
      `SELECT coalesce(sum(record_count), 0) AS rows FROM ${into("ducklake_data_file")} WHERE table_id = ${table.tableId}`
    )
    let held = getBigIntLike(files ?? {}, "rows")
    for (const inlined of inlinedTables.filter(
      (row) => getBigIntLike(row, "table_id") === table.tableId
    )) {
      const [count] = await runtime.query(
        `SELECT count(*) AS rows FROM ${into(getString(inlined, "table_name"))}`
      )
      held += getBigIntLike(count ?? {}, "rows")
    }

    const production = getBigIntLike(expected ?? {}, "rows")
    if (held !== production) {
      throw new LakeStorageError(
        `[SixbDuckLake] The slice of '${table.datasetId}' would hold ${held} rows where its version holds ${production}. Cut the slice again.`
      )
    }
  }
}

/**
 * An empty catalog of the DuckLake format production runs, attached as `alias` to fill in. Its
 * own first snapshot and schema are removed: the slice keeps production's ids.
 */
async function createEmptyCatalog(
  runtime: DuckDbQueryRuntime,
  path: string,
  alias: string
): Promise<void> {
  if (await Bun.file(path).exists()) {
    throw new LakeStorageError(
      `[SixbDuckLake] A lake slice is written to a new file; '${path}' exists.`
    )
  }

  const init = `${alias}_init`
  let attached: string | undefined
  try {
    await runtime.run(
      `ATTACH ${quoteSqlString(`ducklake:${path}`)} AS ${quoteIdentifier(init)} (DATA_PATH ${quoteSqlString(PRODUCTION_FILES_ROOT)})`
    )
    attached = init
    await runtime.run(`DETACH ${quoteIdentifier(init)}`)
    attached = undefined

    await runtime.run(`ATTACH ${quoteSqlString(path)} AS ${quoteIdentifier(alias)}`)
    attached = alias
    for (const row of await catalogTables(runtime, alias)) {
      await runtime.run(`DELETE FROM ${quoteIdentifier(alias)}.${quoteIdentifier(row)}`)
    }
  } catch (error) {
    if (attached) await runtime.run(`DETACH ${quoteIdentifier(attached)}`).catch(() => undefined)
    await rm(path, { force: true })
    await rm(`${path}.wal`, { force: true })
    throw error
  }
}

async function assertKnownCatalogTables(runtime: DuckDbQueryRuntime, alias: string) {
  const unknown = (await catalogTables(runtime, alias)).filter(
    (table) => !CATALOG_TABLES.has(table) && !INLINED_TABLE.test(table)
  )
  if (unknown.length > 0) throw unknownTables(unknown)
}

/**
 * Inlined tables of a family the slice does not know would be left out, with whatever they
 * hold. A PostgreSQL catalog lists its tables; DuckDB lists none of a local catalog's, whose
 * inlined data tables are still listed by DuckLake itself.
 */
async function assertKnownInlinedTables(
  options: DuckLakeStorageOptions,
  runtime: DuckDbQueryRuntime
): Promise<void> {
  const listed = await runtime.query(
    `SELECT table_name FROM ${duckLakeMetadataTableName(options, "ducklake_inlined_data_tables")}`
  )
  const tables = listed.map((row) => getString(row, "table_name"))

  if (options.catalog.type === "postgres") {
    const schema = options.catalog.metadataSchema ?? "public"
    const rows = await runtime.query(
      buildDuckLakeMetadataQuery(
        options,
        () =>
          `SELECT table_name FROM information_schema.tables WHERE table_schema = ${quoteSqlString(schema)} AND table_name LIKE 'ducklake\\_inlined\\_%'`
      )
    )
    tables.push(...rows.map((row) => getString(row, "table_name")))
  }

  const unknown = tables.filter((table) => !INLINED_TABLE.test(table))
  if (unknown.length > 0) throw unknownTables(unknown)
}

function unknownTables(tables: readonly string[]): LakeStorageError {
  return new LakeStorageError(
    `[SixbDuckLake] This DuckLake build keeps ${[...new Set(tables)].join(", ")} in its catalog, which a lake slice does not cut yet. Use the DuckLake build the provider is tested with.`
  )
}

async function assertUnencrypted(
  runtime: DuckDbQueryRuntime,
  meta: (table: string) => string
): Promise<void> {
  const [row] = await runtime.query(
    `SELECT value FROM ${meta("ducklake_metadata")} WHERE key = 'encrypted' AND scope IS NULL`
  )
  if (row !== undefined && getOptionalString(row, "value") === "true") {
    throw new LakeStorageError(
      "[SixbDuckLake] This lake encrypts its files, and a branch reads copies of those with deleted rows, which are not encrypted yet. Branch from an unencrypted lake."
    )
  }
}

async function catalogTables(runtime: DuckDbQueryRuntime, alias: string): Promise<string[]> {
  const rows = await runtime.query(
    `SELECT table_name FROM duckdb_tables() WHERE database_name = ${quoteSqlString(alias)}`
  )
  return rows.map((row) => getString(row, "table_name"))
}

interface LiveAt {
  /** The slice's table ids, as an SQL list. */
  readonly ids: string
  /**
   * Rows of a metadata table live at their table's snapshot, as `alias`, with `joins` before
   * the filter.
   */
  select(columns: string, table: string, alias: string, options?: LiveSelectOptions): string
  /** Copies those rows into the slice, where they end no more. */
  insert(into: string, table: string, key?: string): string
}

interface LiveSelectOptions {
  readonly key?: string
  readonly joins?: string
  /** A condition the rows meet too. */
  readonly where?: string
}

function liveAt(tables: readonly SliceTable[]): LiveAt {
  const ids = tables.map((table) => table.tableId.toString()).join(", ")
  const cut = `(VALUES ${tables.map((table) => `(${table.tableId}, ${table.snapshotId})`).join(", ")}) AS sixb_cut(cut_table_id, cut_snapshot)`

  // The IN list reaches a PostgreSQL catalog; the join with the cut decides exactly.
  const select = (
    columns: string,
    table: string,
    alias: string,
    { key = "table_id", joins = "", where }: LiveSelectOptions = {}
  ) => `
    SELECT ${columns}
    FROM ${table} ${alias}
    JOIN ${cut} ON ${alias}.${key} = sixb_cut.cut_table_id
    ${joins}
    WHERE ${alias}.${key} IN (${ids})
      AND ${alias}.begin_snapshot <= sixb_cut.cut_snapshot
      AND (${alias}.end_snapshot IS NULL OR ${alias}.end_snapshot > sixb_cut.cut_snapshot)
      ${where === undefined ? "" : `AND ${where}`}
  `

  return {
    ids,
    select,
    insert: (into, table, key) =>
      `INSERT INTO ${into} BY NAME ${select("live.* REPLACE (NULL::BIGINT AS end_snapshot)", table, "live", { key })}`,
  }
}

function byParent(into: string, table: string, key: string, parents: string): string {
  return `INSERT INTO ${into} BY NAME SELECT * FROM ${table} WHERE ${key} IN (SELECT ${key} FROM ${parents})`
}

/** Joins a file row (`f`) to its table and schema, whose paths it is relative to. */
function filePathJoins(meta: (table: string) => string): string {
  return `
    JOIN ${meta("ducklake_table")} t ON t.table_id = f.table_id AND t.end_snapshot IS NULL
    JOIN ${meta("ducklake_schema")} s ON s.schema_id = t.schema_id AND s.end_snapshot IS NULL
  `
}

/** Where a file is, as production's DuckDB reads it. */
function locationSql(dataPath: string): string {
  const schema = `CASE WHEN s.path_is_relative THEN ${quoteSqlString(dataPath)} || s.path ELSE s.path END`
  const table = `CASE WHEN t.path_is_relative THEN (${schema}) || t.path ELSE t.path END`
  return `CASE WHEN f.path_is_relative THEN (${table}) || f.path ELSE f.path END`
}

/**
 * A served path as the slice names it in a URL: each segment percent-encoded, as DuckDB sends it
 * and the route decodes it, so partition values of any text reach the same file.
 */
export function encodeServedPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/")
}

function sqlStringOrNull(value: string | undefined): string {
  return value === undefined ? "NULL" : quoteSqlString(value)
}
