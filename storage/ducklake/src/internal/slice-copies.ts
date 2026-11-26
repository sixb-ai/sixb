import { randomBytes } from "node:crypto"
import { rename } from "node:fs/promises"
import { LakeStorageError } from "@sixb/core/lake-storage"
import type { DuckLakeStorageOptions } from "../types"
import { getBigIntLike, getString } from "./duckdb-row"
import type { DuckDbQueryRuntime } from "./duckdb-runtime"
import { COPIES_PREFIX, type LakeFiles } from "./lake-files"
import {
  duckLakeMetadataTableName,
  qualifiedTableName,
  quoteIdentifier,
  quoteSqlString,
} from "./sql"

/** DuckLake reads a row's id from this column when a file carries it, as its compaction writes. */
const ROW_ID_COLUMN = "_ducklake_internal_row_id"
const ROW_ID_FIELD_ID = 2147483540

export interface CopyInput {
  readonly table: {
    readonly tableId: bigint
    readonly tableName: string
    readonly snapshotId: bigint
  }
  readonly dataFileId: bigint
  /** Where production's DuckDB reads the file. */
  readonly location: string
  /** The id of its first row; null when the file carries its rows' ids. */
  readonly rowIdStart: bigint | null
  readonly recordCount: bigint
  /** The copy's name, which says what it holds. */
  readonly name: string
  /** A condition the copy's rows meet too, such as a source-ordering table's live keys. */
  readonly where?: string
}

/**
 * A copy of one data file without the rows its table's snapshot deleted, beside production's data
 * path. It carries each row's id, as DuckLake's own rewrite of such a file does, and its columns'
 * field ids, so a catalog reads it in place of the file: same rows, same ids, nothing deleted.
 *
 * A copy is named by the file and the snapshot it is read at, so one copy serves every slice of
 * that version, whatever their points. One that exists is reused as written, and marked used.
 * Production writes it once, through its own DuckDB, and deletes it when no live slice reads it.
 */
export async function writeCopy(
  options: DuckLakeStorageOptions,
  runtime: DuckDbQueryRuntime,
  files: LakeFiles,
  input: CopyInput
): Promise<{ readonly rows: bigint; readonly bytes: number }> {
  const location = files.copyLocation(input.name)

  if (!(await files.copyExists(input.name))) {
    const { select, fieldIds, names } = await copyColumns(options, runtime, input.table)
    const relation = `${qualifiedTableName(options, input.table.tableName)} AT (VERSION => ${input.table.snapshotId})`

    // The rows of this file the snapshot keeps: by their ids where the file has a range of them,
    // else by the file DuckLake read them from.
    let rows: string
    if (input.rowIdStart !== null) {
      rows = `rowid >= ${input.rowIdStart} AND rowid < ${input.rowIdStart + input.recordCount}`
    } else if (names.some((name) => name.toLowerCase() === "filename")) {
      throw new LakeStorageError(
        `[SixbDuckLake] Table '${input.table.tableName}' has a column named 'filename', which hides the file each row comes from, and file ${input.dataFileId} carries its rows' ids. A branch cannot read it without its deleted rows yet.`
      )
    } else {
      rows = `filename = ${quoteSqlString(input.location)}`
    }
    if (input.where !== undefined) rows = `(${rows}) AND ${input.where}`

    // A local copy appears whole or not at all; an object store commits an upload whole.
    const target = location.includes("://")
      ? location
      : `${location}.${randomBytes(6).toString("hex")}.tmp`
    await runtime.run(`
      COPY (SELECT ${select}, rowid AS ${ROW_ID_COLUMN} FROM ${relation} WHERE ${rows})
      TO ${quoteSqlString(target)} (FORMAT parquet, COMPRESSION zstd, FIELD_IDS {${fieldIds}})
    `)
    if (target !== location) await rename(target, location)
  } else {
    // Its slice is recorded already: production keeps the copy as long as it keeps a new one.
    await files.touchCopy(input.name)
  }

  const [counted] = await runtime.query(
    `SELECT count(*) AS rows FROM read_parquet(${quoteSqlString(location)})`
  )
  const file = await files.open(`${COPIES_PREFIX}${input.name}`)
  if (!file || counted === undefined) {
    throw new LakeStorageError(`[SixbDuckLake] The copy '${input.name}' could not be read back.`)
  }

  return { rows: getBigIntLike(counted, "rows"), bytes: file.sizeBytes }
}

/** The table's columns at its snapshot, with the field ids DuckLake reads them by. */
async function copyColumns(
  options: DuckLakeStorageOptions,
  runtime: DuckDbQueryRuntime,
  table: CopyInput["table"]
): Promise<{ readonly select: string; readonly fieldIds: string; readonly names: string[] }> {
  const rows = await runtime.query(`
    SELECT column_id, column_name, parent_column
    FROM ${duckLakeMetadataTableName(options, "ducklake_column")}
    WHERE table_id = ${table.tableId}
      AND begin_snapshot <= ${table.snapshotId}
      AND (end_snapshot IS NULL OR end_snapshot > ${table.snapshotId})
    ORDER BY column_order
  `)

  const columns = rows.map((row) => ({
    id: getBigIntLike(row, "column_id"),
    name: getString(row, "column_name"),
    parent:
      row.parent_column === null || row.parent_column === undefined
        ? null
        : getBigIntLike(row, "parent_column"),
  }))
  const fieldIdsOf = (parent: bigint | null): string =>
    columns
      .filter((column) => column.parent === parent)
      .map((column) => {
        const children = fieldIdsOf(column.id)
        return `${quoteSqlString(column.name)}: ${
          children ? `{__duckdb_field_id: ${column.id}, ${children}}` : column.id
        }`
      })
      .join(", ")

  const topLevel = columns.filter((column) => column.parent === null).map((column) => column.name)
  return {
    select: topLevel.map((name) => quoteIdentifier(name)).join(", "),
    fieldIds: `${fieldIdsOf(null)}, ${quoteSqlString(ROW_ID_COLUMN)}: ${ROW_ID_FIELD_ID}`,
    names: topLevel,
  }
}
