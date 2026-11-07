import { randomUUID } from "node:crypto"
import type { DatasetColumnDefinition, DatasetRow } from "@sixb/core"
import {
  type DatasetChanges,
  type DatasetRowChange,
  type DatasetVersion,
  LakeStorageError,
  type ReadDatasetChangesInput,
  resolveDatasetChangeColumns,
} from "@sixb/core/lake-storage"
import type { DuckLakeStorageOptions } from "../types"
import { getBigIntLike } from "./duckdb-row"
import type { DuckDbQueryRuntime } from "./duckdb-runtime"
import type { DuckLakeConnectionManager } from "./ducklake-connection-manager"
import { type DatasetTableRef, resolveDatasetTableRef } from "./ducklake-dataset-table-ref"
import type { DatasetSnapshotRow, DuckLakeSnapshotReader } from "./ducklake-snapshot-reader"
import { normalizeReadValue } from "./schema"
import { duckLakeAlias, qualifiedTableName, quoteIdentifier, quoteSqlString } from "./sql"
import { parseVersionId } from "./versions"

const PAGE_ROWS = 5_000

/**
 * Below this many rows in both versions together, comparing them costs no more than reading
 * DuckLake's change feed, which takes a few milliseconds whatever it holds. Measured on DuckDB
 * 1.5.6, the feed was slower at 20,000 rows per version and faster from 50,000.
 */
const FEED_MIN_ROWS = 100_000

/**
 * The change feed is read when the versions in between inserted and deleted at most this share
 * of the rows both versions hold. Past it, comparing the two versions reads less.
 */
const FEED_MAX_CHANGE_SHARE = 0.5

/** Most snapshots naming the dataset that one change read plans its feed over. */
const FEED_MAX_SNAPSHOTS = 512

/**
 * Most snapshots naming the dataset after the earlier version that a change read walks to find
 * that none changed rows. Consumers read changes for every version they apply, so few usually
 * stand between the two.
 */
const UNCHANGED_MAX_SNAPSHOTS = 32

/** Columns DuckLake's change feed adds to the table's: a table column of the same name is ambiguous. */
const FEED_COLUMNS: ReadonlySet<string> = new Set(["snapshot_id", "rowid", "change_type"])

/** The change feed ranges a read covers, between the maintenance commits it skips. */
interface FeedRead {
  readonly table: DatasetTableRef
  readonly ranges: readonly { readonly start: string; readonly end: string }[]
  readonly fromRowCount: number
  readonly toRowCount: number
}

/**
 * Compare once in DuckDB, then page only the delta without holding the connection between yields.
 *
 * Two ways to compare, one result. Reading DuckLake's change feed costs what the versions in
 * between changed: it is used when every one of them recorded what it changed (`rowChanges`),
 * the identity is the dataset's validated primary key, and the feed is still complete (see
 * `planFeedRead`). Otherwise the two versions are joined in full. Neither is read when no version
 * in between changed rows (`holdsRowsOf`).
 */
export class DuckLakeChangeReader {
  constructor(
    private readonly options: DuckLakeStorageOptions,
    private readonly connections: DuckLakeConnectionManager,
    private readonly snapshots: DuckLakeSnapshotReader
  ) {}

  async readChanges(input: ReadDatasetChangesInput): Promise<DatasetChanges | null> {
    input.signal?.throwIfAborted()
    const before = await this.snapshots.getVersion(input.datasetId, input.fromVersionId)
    const after = await this.snapshots.getVersion(input.datasetId, input.toVersionId)
    const columns = resolveDatasetChangeColumns(input, before, after)
    if (!columns || !before || !after) return null

    const lease = await this.connections.acquireAttachedRuntime()
    const runtime = lease.runtime
    const temporary = quoteIdentifier(`sixb_delta_${randomUUID().replaceAll("-", "")}`)
    let retained = false
    let created = false
    try {
      const ref = await resolveDatasetTableRef(this.options, runtime, input.datasetId)
      if (!ref) return null

      if (await this.holdsRowsOf(runtime, ref, input, after)) {
        const table = qualifiedTableName(this.options, ref.tableName)
        return noChanges(
          after.rowCount ??
            before.rowCount ??
            (await rowCountAt(runtime, table, parseVersionId(input.toVersionId)))
        )
      }

      const feed = await this.planFeedRead(runtime, ref, input, before, after)
      input.signal?.throwIfAborted()

      const rowCounts =
        feed !== null && (await this.compareFeed(runtime, temporary, feed, input, columns))
          ? { from: feed.fromRowCount, to: feed.toRowCount }
          : await this.compareVersions(runtime, temporary, ref, input, columns, [before, after])
      if (rowCounts === null) return null
      created = true

      const [count] = await runtime.query(`SELECT count(*) AS count FROM ${temporary}`)
      const changeCount = safeCount(count!, "count")
      input.signal?.throwIfAborted()
      let closePromise: Promise<void> | undefined
      const close = () => {
        closePromise ??= runtime.run(`DROP TABLE IF EXISTS ${temporary}`)
        return closePromise
      }
      const changes = (async function* (): AsyncIterable<DatasetRowChange> {
        try {
          let cursor = -1n
          let delivered = 0
          while (delivered < changeCount) {
            input.signal?.throwIfAborted()
            if (closePromise) throw new LakeStorageError("[SixbDuckLake] Change reader is closed.")
            const page = await runtime.query(`SELECT rowid AS position, * FROM ${temporary}
              WHERE rowid > ${cursor} ORDER BY rowid LIMIT ${PAGE_ROWS}`)
            if (page.length === 0)
              throw new LakeStorageError(
                "[SixbDuckLake] Change read ended before its declared count."
              )
            for (const row of page) {
              input.signal?.throwIfAborted()
              delivered++
              yield {
                before: row.before_present === true ? rowImage(row, "b", columns) : null,
                after: row.after_present === true ? rowImage(row, "a", columns) : null,
              }
            }
            cursor = getBigIntLike(page[page.length - 1]!, "position")
          }
        } finally {
          await close()
        }
      })()
      retained = true
      return {
        fromRowCount: rowCounts.from,
        toRowCount: rowCounts.to,
        changeCount,
        changes,
        close,
      }
    } finally {
      // The delta is a DuckDB temp table, independent of the attached DuckLake catalog. Release
      // the local attachment lock before returning it, otherwise consumer lake operations deadlock.
      try {
        if (!retained && created) await runtime.run(`DROP TABLE IF EXISTS ${temporary}`)
      } finally {
        await lease.release()
      }
    }
  }

  /**
   * Whether the later version holds exactly the rows of the earlier one: every version in between
   * changed none (`rowsChanged`), such as one of new provenance or source ordering. The change set
   * is then empty, whatever the keys, and needs neither the key checks nor the join.
   *
   * It reads the range of versions `planFeedRead` reads, which skips maintenance commits and is
   * incomplete when a snapshot in between was expired or altered the table outside Sixb.
   */
  private async holdsRowsOf(
    runtime: DuckDbQueryRuntime,
    table: DatasetTableRef,
    input: ReadDatasetChangesInput,
    after: DatasetVersion
  ): Promise<boolean> {
    const from = parseVersionId(input.fromVersionId)
    const to = parseVersionId(input.toVersionId)
    if (from === to) {
      return true
    }
    if (after.rowsChanged || BigInt(from) > BigInt(to)) {
      return false
    }

    const range = await this.snapshots.readChangeRange(
      runtime,
      table,
      from,
      to,
      UNCHANGED_MAX_SNAPSHOTS + 1
    )
    const [first, ...later] = range?.complete ? range.versions : []

    return (
      first?.snapshotId === from &&
      later.at(-1)?.snapshotId === to &&
      later.every((version) => !version.rowsChanged)
    )
  }

  /**
   * Writes the delta into `temporary` by joining both versions in full. Null, writing nothing,
   * when the identity is not unique and nonblank in both. In versions too large to count their
   * distinct keys at no cost (`FEED_MIN_ROWS`), a primary key both validated is unique already:
   * only its blank values are looked for.
   */
  private async compareVersions(
    runtime: DuckDbQueryRuntime,
    temporary: string,
    table: DatasetTableRef,
    input: ReadDatasetChangesInput,
    columns: readonly DatasetColumnDefinition[],
    versions: readonly [DatasetVersion, DatasetVersion]
  ): Promise<{ readonly from: number; readonly to: number } | null> {
    const relation = qualifiedTableName(this.options, table.tableName)
    const oldRelation = `${relation} AT (VERSION => ${parseVersionId(input.fromVersionId)})`
    const newRelation = `${relation} AT (VERSION => ${parseVersionId(input.toVersionId)})`

    const [before, after] = versions
    const small =
      before.rowCount !== undefined &&
      after.rowCount !== undefined &&
      before.rowCount + after.rowCount < FEED_MIN_ROWS
    const validated = !small && (await this.validatedOn(runtime, table, input))

    const count = validated ? nonblankRowCount : uniqueRowCount
    const from = await count(runtime, oldRelation, input.keyColumns)
    const to = await count(runtime, newRelation, input.keyColumns)
    if (from === null || to === null) return null
    input.signal?.throwIfAborted()

    await runtime.run(
      `CREATE TEMP TABLE ${temporary} AS ${deltaSql(
        `SELECT * FROM ${oldRelation}`,
        `SELECT * FROM ${newRelation}`,
        input.keyColumns,
        columns
      )}`
    )
    return { from, to }
  }

  /** Whether both versions validated the identity as their primary key. */
  private async validatedOn(
    runtime: DuckDbQueryRuntime,
    table: DatasetTableRef,
    input: ReadDatasetChangesInput
  ): Promise<boolean> {
    for (const versionId of [input.fromVersionId, input.toVersionId]) {
      const row = await this.snapshots.getSnapshotRow(runtime, table, parseVersionId(versionId))
      if (row === null || !keyedOn(row, input.keyColumns)) {
        return false
      }
    }

    return true
  }

  /**
   * The change feed ranges that hold exactly what changed from one version to the other, or null
   * when comparing the versions is the safe or the cheaper way. The feed records rows as written:
   *
   * - every version in between must say how many rows it inserted and deleted (`rowChanges`), so
   *   none was written outside Sixb or before Sixb recorded it, and none changed the schema;
   * - every snapshot in between must still exist, since retention may have expired a version;
   * - the identity must be the primary key both versions validated, as unique and stable;
   * - what changed must be small next to the rows both versions hold. A full replacement in
   *   between counts every row twice, so it falls back on its own.
   *
   * Maintenance commits record the rows they move as updates of every one of them: the ranges
   * stop before them and start again after.
   */
  private async planFeedRead(
    runtime: DuckDbQueryRuntime,
    table: DatasetTableRef,
    input: ReadDatasetChangesInput,
    before: DatasetVersion,
    after: DatasetVersion
  ): Promise<FeedRead | null> {
    const from = parseVersionId(input.fromVersionId)
    const to = parseVersionId(input.toVersionId)
    if (
      BigInt(from) >= BigInt(to) ||
      after.schema.columns.some((column) => FEED_COLUMNS.has(column.name))
    ) {
      return null
    }

    // An unguarded append records no row count; counting reads file metadata, not rows.
    const relation = qualifiedTableName(this.options, table.tableName)
    const fromRowCount = before.rowCount ?? (await rowCountAt(runtime, relation, from))
    const toRowCount = after.rowCount ?? (await rowCountAt(runtime, relation, to))
    if (fromRowCount + toRowCount < FEED_MIN_ROWS) {
      return null
    }

    const range = await this.snapshots.readChangeRange(runtime, table, from, to, FEED_MAX_SNAPSHOTS)
    if (!range?.complete) {
      return null
    }

    const [first, ...later] = range.versions
    const last = later.at(-1)
    if (
      first?.snapshotId !== from ||
      last?.snapshotId !== to ||
      !keyedOn(first, input.keyColumns) ||
      !keyedOn(last, input.keyColumns)
    ) {
      return null
    }

    let rowChanges = 0
    for (const version of later) {
      const changed = version.metadata?.rowChanges
      if (changed === undefined || version.mode === "schema") {
        return null
      }
      rowChanges += changed
    }

    if (rowChanges > FEED_MAX_CHANGE_SHARE * (fromRowCount + toRowCount)) {
      return null
    }

    const maintenance = range.maintenanceSnapshotIds.map((snapshotId) => BigInt(snapshotId))
    const ranges: { start: string; end: string }[] = []
    for (const version of later) {
      const current = ranges.at(-1)
      const id = BigInt(version.snapshotId)
      if (current && !maintenance.some((m) => m > BigInt(current.end) && m < id)) {
        current.end = version.snapshotId
      } else {
        ranges.push({ start: version.snapshotId, end: version.snapshotId })
      }
    }

    return { table, ranges, fromRowCount, toRowCount }
  }

  /**
   * Writes the delta from the change feed into `temporary`, in the shape the full comparison
   * writes. A row inserted and deleted again in between cancels out, by its row id, which
   * DuckLake keeps for a row's lifetime, compaction included. Whether it could: false, writing
   * nothing, for a feed holding anything but inserts and deletes, which Sixb writes alone, or a
   * blank key, which the full comparison refuses.
   */
  private async compareFeed(
    runtime: DuckDbQueryRuntime,
    temporary: string,
    feed: FeedRead,
    input: ReadDatasetChangesInput,
    columns: readonly DatasetColumnDefinition[]
  ): Promise<boolean> {
    const raw = quoteIdentifier(`sixb_feed_${randomUUID().replaceAll("-", "")}`)
    const names = columns.map((column) => quoteIdentifier(column.name)).join(", ")
    const reads = feed.ranges.map(
      ({ start, end }) => `
        SELECT rowid, change_type, ${names}
        FROM ducklake_table_changes(
          ${quoteSqlString(duckLakeAlias(this.options))}, 'main',
          ${quoteSqlString(feed.table.tableName)}, ${start}, ${end}
        )`
    )

    await runtime.run(`CREATE TEMP TABLE ${raw} AS ${reads.join(" UNION ALL ")}`)
    try {
      const [check] = await runtime.query(`
        SELECT
          count(*) FILTER (WHERE change_type NOT IN ('insert', 'delete')) AS other_changes,
          count(*) FILTER (WHERE ${invalidKeysSql(input.keyColumns)}) AS invalid_keys
        FROM ${raw}
      `)
      if (safeCount(check!, "other_changes") > 0 || safeCount(check!, "invalid_keys") > 0) {
        return false
      }

      const present = (kind: string, cancelledBy: string) => `
        SELECT ${names}
        FROM ${raw}
        WHERE change_type = '${kind}'
          AND rowid NOT IN (SELECT rowid FROM ${raw} WHERE change_type = '${cancelledBy}')`

      await runtime.run(`CREATE TEMP TABLE ${temporary} AS
        ${deltaSql(present("delete", "insert"), present("insert", "delete"), input.keyColumns, columns)}`)
      return true
    } finally {
      await runtime.run(`DROP TABLE IF EXISTS ${raw}`)
    }
  }
}

async function rowCountAt(
  runtime: DuckDbQueryRuntime,
  relation: string,
  snapshotId: string
): Promise<number> {
  const [row] = await runtime.query(
    `SELECT count(*) AS total FROM ${relation} AT (VERSION => ${snapshotId})`
  )
  return safeCount(row!, "total")
}

/** Whether a version validated exactly these columns as its primary key. */
function keyedOn(version: DatasetSnapshotRow, keyColumns: readonly string[]): boolean {
  const validated = version.metadata?.validatedPrimaryKeyColumns
  return (
    validated !== undefined &&
    validated.length === keyColumns.length &&
    keyColumns.every((column) => validated.includes(column))
  )
}

/**
 * The changed rows of two row images joined on their identity: one image missing, or any
 * requested column different.
 */
function deltaSql(
  beforeSql: string,
  afterSql: string,
  keyColumns: readonly string[],
  columns: readonly DatasetColumnDefinition[]
): string {
  const key = quoteIdentifier(keyColumns[0]!)
  const values = columns.flatMap((column, index) => [
    `b.${quoteIdentifier(column.name)} AS b${index}`,
    `a.${quoteIdentifier(column.name)} AS a${index}`,
  ])
  const join = keyColumns
    .map((name) => `b.${quoteIdentifier(name)} = a.${quoteIdentifier(name)}`)
    .join(" AND ")
  const changed = columns
    .map(
      (column) =>
        `b.${quoteIdentifier(column.name)} IS DISTINCT FROM a.${quoteIdentifier(column.name)}`
    )
    .join(" OR ")

  return `
    SELECT b.${key} IS NOT NULL AS before_present, a.${key} IS NOT NULL AS after_present,
      ${values.join(", ")}
    FROM (${beforeSql}) b
    FULL OUTER JOIN (${afterSql}) a ON ${join}
    WHERE b.${key} IS NULL OR a.${key} IS NULL OR ${changed}`
}

function invalidKeysSql(keys: readonly string[]): string {
  return keys
    .map(quoteIdentifier)
    .map((name) => `${name} IS NULL OR trim(${name}) = ''`)
    .join(" OR ")
}

function noChanges(rowCount: number): DatasetChanges {
  return {
    fromRowCount: rowCount,
    toRowCount: rowCount,
    changeCount: 0,
    changes: (async function* () {
      yield* []
    })(),
    async close() {},
  }
}

async function uniqueRowCount(
  runtime: DuckDbQueryRuntime,
  relation: string,
  keys: readonly string[]
): Promise<number | null> {
  const names = keys.map(quoteIdentifier)
  const [row] = await runtime.query(`SELECT count(*) AS total,
    count(DISTINCT (${names.join(", ")})) AS unique_keys,
    count(*) FILTER (WHERE ${invalidKeysSql(keys)}) AS invalid_keys FROM ${relation}`)
  const count = safeCount(row!, "total")
  return safeCount(row!, "unique_keys") === count && safeCount(row!, "invalid_keys") === 0
    ? count
    : null
}

/** The relation's row count, or null when a key is blank. */
async function nonblankRowCount(
  runtime: DuckDbQueryRuntime,
  relation: string,
  keys: readonly string[]
): Promise<number | null> {
  const [row] = await runtime.query(`SELECT count(*) AS total,
    count(*) FILTER (WHERE ${invalidKeysSql(keys)}) AS invalid_keys FROM ${relation}`)
  return safeCount(row!, "invalid_keys") === 0 ? safeCount(row!, "total") : null
}

function safeCount(row: Readonly<Record<string, unknown>>, name: string): number {
  const count = Number(getBigIntLike(row, name))
  if (!Number.isSafeInteger(count) || count < 0)
    throw new LakeStorageError("[SixbDuckLake] Change count exceeds the supported integer range.")
  return count
}

function rowImage(
  row: Readonly<Record<string, unknown>>,
  prefix: "a" | "b",
  columns: readonly DatasetColumnDefinition[]
): DatasetRow {
  return Object.fromEntries(
    columns.map((column, index) => [
      column.name,
      normalizeReadValue(row[`${prefix}${index}`], column),
    ])
  )
}
