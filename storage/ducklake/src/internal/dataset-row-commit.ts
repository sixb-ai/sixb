import { randomUUID } from "node:crypto"
import type { DatasetDefinition } from "@sixb/core"
import {
  type DatasetWriteMode,
  getDatasetPrimaryKeyColumns,
  LakeStorageError,
} from "@sixb/core/lake-storage"
import type { DuckLakeStorageOptions } from "../types"
import { getBigIntLike } from "./duckdb-row"
import type { DuckDbQueryRuntime } from "./duckdb-runtime"
import { encodeDatasetTableName } from "./names"
import { datasetSchemaColumnNamesSql } from "./schema"
import { qualifiedTableName, quoteIdentifier } from "./sql"

export type CommitRowCount =
  | { readonly kind: "exact"; readonly value: number }
  | { readonly kind: "unknown" }

export interface ApplyDatasetRowsResult {
  readonly dataChangeExpected: boolean
  readonly sourceRowCount: number
  readonly resultingRowCount: CommitRowCount
  /**
   * The table held no rows when this transaction read it. A write into an empty table deletes
   * nothing, so DuckLake lets it commit alongside a concurrent one that also read the table empty.
   */
  readonly targetWasEmpty: boolean
  /**
   * Rows of the dataset table this write inserts and deletes, an updated row counting in both:
   * what DuckLake checks against concurrent changes to the table. A merge that only advances
   * source ordering changes none.
   */
  readonly insertedRows: number
  readonly deletedRows: number
  /** A keyed snapshot compared its rows and most of them changed (`changesMostRows`). */
  readonly mostRowsChanged?: boolean
}

/**
 * A keyed snapshot that changes at least this share of the rows replaces them all, as Foundry
 * reindexes past 80% of rows changed: the difference would delete and insert nearly as much, and
 * leave the table's rows spread over more files.
 */
const FULL_REPLACEMENT_SHARE = 0.8

/**
 * A large difference is replaced from a far smaller share: deleting many rows across a table's
 * files costs more than writing every row anew. Measured on DuckDB 1.5.6, a difference of 10% of a
 * million rows took as long as a full replacement, and 20% half as long again; with 100,000 rows,
 * 60% took 12% longer. Up to 5,000 rows, or 5% of the table, it was faster, as it was at any share
 * of 5,000 rows or fewer.
 */
const LARGE_DIFFERENCE_ROWS = 5_000
const LARGE_DIFFERENCE_SHARE = 0.05

function changesMostRows(changedKeys: number, tableRows: number): boolean {
  return changedKeys >= FULL_REPLACEMENT_SHARE * tableRows
}

/** Whether a keyed snapshot changing this many rows of a table this size replaces them all. */
export function replacesEveryRow(changedKeys: number, tableRows: number): boolean {
  return (
    changesMostRows(changedKeys, tableRows) ||
    (changedKeys >= LARGE_DIFFERENCE_ROWS && changedKeys >= LARGE_DIFFERENCE_SHARE * tableRows)
  )
}

/**
 * Below this many rows a snapshot always compares its rows: the comparison costs too little for
 * skipping it to pay, and a replacement of rows that did not change costs more.
 */
export const LARGE_TABLE_ROWS = LARGE_DIFFERENCE_ROWS / LARGE_DIFFERENCE_SHARE

export function assertDatasetWriteMode(
  mode: unknown,
  operation: string
): asserts mode is DatasetWriteMode {
  if (mode !== "snapshot" && mode !== "append") {
    throw new LakeStorageError(
      `[SixbDuckLake] Invalid ${operation} mode '${String(mode)}'. Expected 'snapshot' or 'append'.`
    )
  }
}

export async function applyDatasetRowsFromRelation(input: {
  readonly options: DuckLakeStorageOptions
  readonly runtime: DuckDbQueryRuntime
  readonly dataset: DatasetDefinition
  readonly mode: DatasetWriteMode
  /** Provider-rendered relation SQL, such as a quoted staging or temp table. */
  readonly sourceRelationSql: string
  readonly previousRowCount?: number
  /** A keyed snapshot replaces every row without comparing them first (see the coordinator). */
  readonly expectReplacement?: boolean
}): Promise<ApplyDatasetRowsResult> {
  const tableName = encodeDatasetTableName(input.dataset.id)
  const table = qualifiedTableName(input.options, tableName)
  const columnsSql = datasetSchemaColumnNamesSql(input.dataset.schema)
  const primaryKeyColumns = getDatasetPrimaryKeyColumns(input.dataset)

  let baselineRowCount: number | undefined
  let sourceRowCount: number | undefined
  if (primaryKeyColumns !== null) {
    sourceRowCount = await inspectUniqueKeyedRelation({
      runtime: input.runtime,
      dataset: input.dataset,
      relationSql: input.sourceRelationSql,
      context: `${input.mode} source`,
    })

    if (input.mode === "append") {
      baselineRowCount = await inspectUniqueKeyedRelation({
        runtime: input.runtime,
        dataset: input.dataset,
        relationSql: table,
        context: "current baseline",
      })
      await assertNoPrimaryKeyOverlap({
        runtime: input.runtime,
        dataset: input.dataset,
        leftRelationSql: input.sourceRelationSql,
        rightRelationSql: table,
        context: "append",
      })
    }
  }

  if (input.mode === "snapshot") {
    if (primaryKeyColumns !== null && sourceRowCount !== undefined && !input.expectReplacement) {
      return applyKeyedSnapshot({
        runtime: input.runtime,
        dataset: input.dataset,
        table,
        sourceRelationSql: input.sourceRelationSql,
        sourceRowCount,
        previousRowCount: input.previousRowCount,
        primaryKeyColumns,
      })
    }

    const source = await fingerprintRelation(input.runtime, input.sourceRelationSql, columnsSql)
    const target = await fingerprintRelation(input.runtime, table, columnsSql)

    if (sameFingerprint(source, target)) {
      return unchangedSnapshot(source.rowCount, target.rowCount)
    }

    return replaceRows({
      runtime: input.runtime,
      table,
      columnsSql,
      sourceRelationSql: input.sourceRelationSql,
      sourceRowCount: source.rowCount,
      targetRowCount: target.rowCount,
    })
  }

  const appendedRowCount = await countRows(input.runtime, input.sourceRelationSql)
  const knownRowCount = baselineRowCount ?? input.previousRowCount
  const targetWasEmpty =
    knownRowCount === undefined ? await isEmptyRelation(input.runtime, table) : knownRowCount === 0
  await input.runtime.run(
    `INSERT INTO ${table} (${columnsSql}) SELECT ${columnsSql} FROM ${input.sourceRelationSql}`
  )

  return {
    dataChangeExpected: appendedRowCount > 0,
    targetWasEmpty,
    sourceRowCount: appendedRowCount,
    resultingRowCount:
      input.previousRowCount === undefined
        ? { kind: "unknown" }
        : { kind: "exact", value: input.previousRowCount + appendedRowCount },
    insertedRows: appendedRowCount,
    deletedRows: 0,
  }
}

interface KeyedSnapshotInput {
  readonly runtime: DuckDbQueryRuntime
  readonly dataset: DatasetDefinition
  readonly table: string
  readonly sourceRelationSql: string
  readonly sourceRowCount: number
  /** The row count the latest version recorded, when the commit read it. */
  readonly previousRowCount?: number
  readonly primaryKeyColumns: readonly string[]
}

interface DeltaCounts {
  readonly changedKeys: number
  readonly insertedRows: number
  readonly deletedRows: number
}

/**
 * Writes a keyed snapshot as the difference from the table it read: deletes the rows whose key
 * is gone or whose values changed, and inserts the staged rows that are new or changed. The
 * version holds exactly the rows a full replacement would, and DuckLake's change feed then shows
 * only what changed, instead of every row deleted and inserted again.
 *
 * One join of the staged rows with the table decides it, in place of comparing a fingerprint of
 * each. A table that was empty, or a write that changes enough of its rows (`replacesEveryRow`),
 * replaces them all instead.
 */
async function applyKeyedSnapshot(input: KeyedSnapshotInput): Promise<ApplyDatasetRowsResult> {
  const delta = quoteIdentifier(`sixb_snapshot_delta_${randomUUID().replaceAll("-", "")}`)

  await createSnapshotDelta(input, delta)

  try {
    const counts = await readDeltaCounts(input.runtime, delta)

    // The source holds every row the table keeps, so the table held those plus the deleted ones,
    // provided its keys are unique. A table holding more, such as a key a client outside Sixb
    // inserted twice, is replaced: a difference would keep the duplicate.
    const targetRowCount = input.sourceRowCount - counts.insertedRows + counts.deletedRows
    const actualRowCount = input.previousRowCount ?? (await countRows(input.runtime, input.table))
    if (actualRowCount !== targetRowCount) {
      return await replaceSnapshotRows(input, actualRowCount)
    }

    if (counts.changedKeys === 0) {
      return unchangedSnapshot(input.sourceRowCount, targetRowCount)
    }

    // An updated row is one changed key, both deleted and inserted.
    const largerSide = Math.max(input.sourceRowCount, targetRowCount)
    if (targetRowCount === 0 || replacesEveryRow(counts.changedKeys, largerSide)) {
      return {
        ...(await replaceSnapshotRows(input, targetRowCount)),
        mostRowsChanged: targetRowCount > 0 && changesMostRows(counts.changedKeys, largerSide),
      }
    }

    return await applyDelta(input, delta, counts)
  } finally {
    await dropTemporaryTable(input.runtime, delta)
  }
}

/**
 * Stores the key of every row the snapshot adds, removes or changes, and on which side it is.
 * Keys are non-null and unique on both sides, so a missing side means a new or a removed row.
 */
async function createSnapshotDelta(input: KeyedSnapshotInput, delta: string): Promise<void> {
  const firstKey = quoteIdentifier(input.primaryKeyColumns[0]!)
  const sourceMissing = `source.${firstKey} IS NULL`
  const targetMissing = `target.${firstKey} IS NULL`
  const deltaKeysSql = input.primaryKeyColumns
    .map((column) => {
      const name = quoteIdentifier(column)
      return `coalesce(source.${name}, target.${name}) AS ${name}`
    })
    .join(", ")

  await input.runtime.run(`
    CREATE TEMP TABLE ${delta} AS
    SELECT
      ${deltaKeysSql},
      NOT (${sourceMissing}) AS in_source,
      NOT (${targetMissing}) AS in_target
    FROM ${input.sourceRelationSql} source
    FULL OUTER JOIN ${input.table} target
      ON ${primaryKeyMatchSql(input.primaryKeyColumns, "source", "target")}
    WHERE ${sourceMissing}
      OR ${targetMissing}
      OR (${datasetRowDifferenceSql(input.dataset, "source", "target")})
  `)
}

async function readDeltaCounts(runtime: DuckDbQueryRuntime, delta: string): Promise<DeltaCounts> {
  const [counts] = await runtime.query(`
    SELECT
      count(*) AS changed_keys,
      count(*) FILTER (WHERE in_source) AS inserted,
      count(*) FILTER (WHERE in_target) AS deleted
    FROM ${delta}
  `)

  return {
    changedKeys: counts === undefined ? 0 : Number(getBigIntLike(counts, "changed_keys")),
    insertedRows: counts === undefined ? 0 : Number(getBigIntLike(counts, "inserted")),
    deletedRows: counts === undefined ? 0 : Number(getBigIntLike(counts, "deleted")),
  }
}

function replaceSnapshotRows(
  input: KeyedSnapshotInput,
  targetRowCount: number
): Promise<ApplyDatasetRowsResult> {
  return replaceRows({
    runtime: input.runtime,
    table: input.table,
    columnsSql: datasetSchemaColumnNamesSql(input.dataset.schema),
    sourceRelationSql: input.sourceRelationSql,
    sourceRowCount: input.sourceRowCount,
    targetRowCount,
  })
}

/** Deletes what the delta says went or changed, then inserts what it says came or changed. */
async function applyDelta(
  input: KeyedSnapshotInput,
  delta: string,
  counts: DeltaCounts
): Promise<ApplyDatasetRowsResult> {
  const { runtime, table, sourceRelationSql, primaryKeyColumns } = input
  const columnsSql = datasetSchemaColumnNamesSql(input.dataset.schema)

  const oneSided = counts.insertedRows === 0 || counts.deletedRows === 0
  if (oneSided) {
    await addUnchangedRowToDelta(input, delta)
  }

  await runtime.run(`
    DELETE FROM ${table} AS target
    USING ${delta} AS delta
    WHERE delta.in_target
      AND ${primaryKeyMatchSql(primaryKeyColumns, "target", "delta")}
  `)

  await runtime.run(`
    INSERT INTO ${table} (${columnsSql})
    SELECT ${columnsSql}
    FROM ${sourceRelationSql} source
    WHERE EXISTS (
      SELECT 1
      FROM ${delta} delta
      WHERE delta.in_source
        AND ${primaryKeyMatchSql(primaryKeyColumns, "source", "delta")}
    )
  `)

  return {
    dataChangeExpected: true,
    sourceRowCount: input.sourceRowCount,
    resultingRowCount: { kind: "exact", value: input.sourceRowCount },
    targetWasEmpty: false,
    insertedRows: oneSided ? counts.insertedRows + 1 : counts.insertedRows,
    deletedRows: oneSided ? counts.deletedRows + 1 : counts.deletedRows,
  }
}

/**
 * DuckLake commits two writes that only insert concurrently, and two that only delete from
 * different files: a difference that would only do one rewrites an unchanged row too, so that any
 * concurrent change to the table's rows conflicts with it, as with a replacement.
 */
async function addUnchangedRowToDelta(input: KeyedSnapshotInput, delta: string): Promise<void> {
  const sourceKeysSql = input.primaryKeyColumns
    .map((column) => `source.${quoteIdentifier(column)}`)
    .join(", ")

  await input.runtime.run(`
    INSERT INTO ${delta}
    SELECT ${sourceKeysSql}, true, true
    FROM ${input.sourceRelationSql} source
    WHERE NOT EXISTS (
      SELECT 1
      FROM ${delta} delta
      WHERE ${primaryKeyMatchSql(input.primaryKeyColumns, "source", "delta")}
    )
    LIMIT 1
  `)
}

/** Deletes every row of the table, then inserts every source row. */
async function replaceRows(input: {
  readonly runtime: DuckDbQueryRuntime
  readonly table: string
  readonly columnsSql: string
  readonly sourceRelationSql: string
  readonly sourceRowCount: number
  readonly targetRowCount: number
}): Promise<ApplyDatasetRowsResult> {
  await input.runtime.run(`DELETE FROM ${input.table}`)
  await input.runtime.run(
    `INSERT INTO ${input.table} (${input.columnsSql}) SELECT ${input.columnsSql} FROM ${input.sourceRelationSql}`
  )

  return {
    dataChangeExpected: input.sourceRowCount > 0 || input.targetRowCount > 0,
    sourceRowCount: input.sourceRowCount,
    resultingRowCount: { kind: "exact", value: input.sourceRowCount },
    targetWasEmpty: input.targetRowCount === 0,
    insertedRows: input.sourceRowCount,
    deletedRows: input.targetRowCount,
  }
}

function unchangedSnapshot(sourceRowCount: number, targetRowCount: number): ApplyDatasetRowsResult {
  return {
    dataChangeExpected: false,
    sourceRowCount,
    resultingRowCount: { kind: "exact", value: targetRowCount },
    targetWasEmpty: targetRowCount === 0,
    insertedRows: 0,
    deletedRows: 0,
  }
}

/** Matches rows of two relations on every primary key column. */
export function primaryKeyMatchSql(
  primaryKeyColumns: readonly string[],
  leftAlias: string,
  rightAlias: string
): string {
  return primaryKeyColumns
    .map(
      (column) =>
        `${leftAlias}.${quoteIdentifier(column)} = ${rightAlias}.${quoteIdentifier(column)}`
    )
    .join(" AND ")
}

/**
 * Whether two matched rows differ in any column of the dataset, nulls included. A row that
 * differs only in its `sequenceBy` column is the stored row delivered again
 * (`isSequenceOnlyChange`): a merge keeps it as is, while the companion table still advances the
 * key's ordering. Only merges write a sequenced dataset.
 */
export function datasetRowDifferenceSql(
  dataset: DatasetDefinition,
  leftAlias: string,
  rightAlias: string
): string {
  const differences = dataset.schema.columns
    .filter((column) => column.name !== dataset.sequenceBy)
    .map(
      (column) =>
        `${leftAlias}.${quoteIdentifier(column.name)} IS DISTINCT FROM ${rightAlias}.${quoteIdentifier(
          column.name
        )}`
    )

  return differences.length > 0 ? differences.join(" OR ") : "FALSE"
}

async function dropTemporaryTable(runtime: DuckDbQueryRuntime, table: string): Promise<void> {
  try {
    await runtime.run(`DROP TABLE IF EXISTS ${table}`)
  } catch {
    // Preserve the write's outcome. DuckDB rejects statements once the transaction is aborted;
    // the coordinator rolls it back next, which drops the table it created.
  }
}

export async function inspectUniqueKeyedRelation(input: {
  readonly runtime: DuckDbQueryRuntime
  readonly dataset: DatasetDefinition
  readonly relationSql: string
  readonly context: string
}): Promise<number> {
  const primaryKeyColumns = getDatasetPrimaryKeyColumns(input.dataset)
  if (primaryKeyColumns === null) {
    throw new LakeStorageError(
      `[SixbDuckLake] Dataset '${input.dataset.id}' must define a primaryKey before rows can be keyed.`
    )
  }

  const keysSql = primaryKeyColumns.map((column) => quoteIdentifier(column)).join(", ")
  const [row] = await input.runtime.query(`
    SELECT
      count(*) AS row_count,
      coalesce(max(key_count), 0) AS max_key_count
    FROM (
      SELECT count(*) OVER (PARTITION BY ${keysSql}) AS key_count
      FROM ${input.relationSql}
    ) keyed_rows
  `)

  const rowCount = row === undefined ? 0 : Number(getBigIntLike(row, "row_count"))
  const maxKeyCount = row === undefined ? 0 : Number(getBigIntLike(row, "max_key_count"))
  if (maxKeyCount > 1) {
    throw new LakeStorageError(
      `[SixbDuckLake] Dataset '${input.dataset.id}' ${input.context} contains duplicate primary key.`
    )
  }

  return rowCount
}

async function assertNoPrimaryKeyOverlap(input: {
  readonly runtime: DuckDbQueryRuntime
  readonly dataset: DatasetDefinition
  readonly leftRelationSql: string
  readonly rightRelationSql: string
  readonly context: string
}): Promise<void> {
  const primaryKeyColumns = getDatasetPrimaryKeyColumns(input.dataset)
  if (primaryKeyColumns === null) {
    return
  }

  const matchSql = primaryKeyColumns
    .map((column) => `left_rows.${quoteIdentifier(column)} = right_rows.${quoteIdentifier(column)}`)
    .join(" AND ")
  const [collision] = await input.runtime.query(`
    SELECT 1
    FROM ${input.leftRelationSql} left_rows
    JOIN ${input.rightRelationSql} right_rows ON ${matchSql}
    LIMIT 1
  `)
  if (collision !== undefined) {
    throw new LakeStorageError(
      `[SixbDuckLake] Dataset '${input.dataset.id}' ${input.context} contains duplicate primary key.`
    )
  }
}

interface RelationFingerprint {
  readonly rowCount: number
  readonly hashSum: string
  readonly hashXor: string
}

async function fingerprintRelation(
  runtime: DuckDbQueryRuntime,
  relationSql: string,
  columnsSql: string
): Promise<RelationFingerprint> {
  const [row] = await runtime.query(`
    SELECT
      count(*) AS row_count,
      coalesce(sum(hash(${columnsSql})::HUGEINT), 0::HUGEINT) AS hash_sum,
      coalesce(bit_xor(hash('sixb:snapshot:v1', ${columnsSql})), 0::UBIGINT) AS hash_xor
    FROM ${relationSql}
  `)

  if (row === undefined) {
    return { rowCount: 0, hashSum: "0", hashXor: "0" }
  }

  return {
    rowCount: Number(getBigIntLike(row, "row_count")),
    hashSum: getBigIntLike(row, "hash_sum").toString(),
    hashXor: getBigIntLike(row, "hash_xor").toString(),
  }
}

function sameFingerprint(left: RelationFingerprint, right: RelationFingerprint): boolean {
  return (
    left.rowCount === right.rowCount &&
    left.hashSum === right.hashSum &&
    left.hashXor === right.hashXor
  )
}

async function countRows(runtime: DuckDbQueryRuntime, relationSql: string): Promise<number> {
  const [row] = await runtime.query(`SELECT count(*) AS row_count FROM ${relationSql}`)
  if (row === undefined) {
    return 0
  }

  return Number(getBigIntLike(row, "row_count"))
}

async function isEmptyRelation(runtime: DuckDbQueryRuntime, relationSql: string): Promise<boolean> {
  const rows = await runtime.query(`SELECT 1 AS present FROM ${relationSql} LIMIT 1`)
  return rows.length === 0
}
