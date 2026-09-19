import { randomUUID } from "node:crypto"
import type { DatasetColumnDefinition, DatasetRow } from "@sixb/core"
import {
  type DatasetChanges,
  type DatasetRowChange,
  LakeStorageError,
  type ReadDatasetChangesInput,
  resolveDatasetChangeColumns,
} from "@sixb/core/lake-storage"
import type { DuckLakeStorageOptions } from "../types"
import { getBigIntLike } from "./duckdb-row"
import type { DuckDbQueryRuntime } from "./duckdb-runtime"
import type { DuckLakeConnectionManager } from "./ducklake-connection-manager"
import { resolveDatasetTableRef } from "./ducklake-dataset-table-ref"
import type { DuckLakeSnapshotReader } from "./ducklake-snapshot-reader"
import { normalizeReadValue } from "./schema"
import { qualifiedTableName, quoteIdentifier } from "./sql"
import { parseVersionId } from "./versions"

const PAGE_ROWS = 5_000

/** Compare once in DuckDB, then page only the delta without holding the connection between yields. */
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
    if (!columns) return null
    const lease = await this.connections.acquireAttachedRuntime()
    const runtime = lease.runtime
    const temporary = quoteIdentifier(`sixb_delta_${randomUUID().replaceAll("-", "")}`)
    let retained = false
    let created = false
    try {
      const ref = await resolveDatasetTableRef(this.options, runtime, input.datasetId)
      if (!ref) return null
      const table = qualifiedTableName(this.options, ref.tableName)
      const oldRelation = `${table} AT (VERSION => ${parseVersionId(input.fromVersionId)})`
      const newRelation = `${table} AT (VERSION => ${parseVersionId(input.toVersionId)})`
      const previousCount = await uniqueRowCount(runtime, oldRelation, input.keyColumns)
      const nextCount = await uniqueRowCount(runtime, newRelation, input.keyColumns)
      if (previousCount === null || nextCount === null) return null
      input.signal?.throwIfAborted()
      const key = quoteIdentifier(input.keyColumns[0]!)
      const values = columns.flatMap((column, index) => [
        `b.${quoteIdentifier(column.name)} AS b${index}`,
        `a.${quoteIdentifier(column.name)} AS a${index}`,
      ])
      const join = input.keyColumns
        .map((name) => `b.${quoteIdentifier(name)} = a.${quoteIdentifier(name)}`)
        .join(" AND ")
      const changed = columns
        .map(
          (column) =>
            `b.${quoteIdentifier(column.name)} IS DISTINCT FROM a.${quoteIdentifier(column.name)}`
        )
        .join(" OR ")
      // The native change feed reflects DELETE/INSERT writes: snapshot ingestion can produce 2N
      // physical changes for one logical edit. Compare the pinned states instead of replaying it.
      await runtime.run(`CREATE TEMP TABLE ${temporary} AS
        SELECT b.${key} IS NOT NULL AS before_present, a.${key} IS NOT NULL AS after_present,
          ${values.join(", ")}
        FROM (SELECT * FROM ${oldRelation}) b
        FULL OUTER JOIN (SELECT * FROM ${newRelation}) a ON ${join}
        WHERE b.${key} IS NULL OR a.${key} IS NULL OR ${changed}`)
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
      return { fromRowCount: previousCount, toRowCount: nextCount, changeCount, changes, close }
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
}

async function uniqueRowCount(
  runtime: DuckDbQueryRuntime,
  relation: string,
  keys: readonly string[]
): Promise<number | null> {
  const names = keys.map(quoteIdentifier)
  const invalid = names.map((name) => `${name} IS NULL OR trim(${name}) = ''`).join(" OR ")
  const [row] = await runtime.query(`SELECT count(*) AS total,
    count(DISTINCT (${names.join(", ")})) AS unique_keys,
    count(*) FILTER (WHERE ${invalid}) AS invalid_keys FROM ${relation}`)
  const count = safeCount(row!, "total")
  return safeCount(row!, "unique_keys") === count && safeCount(row!, "invalid_keys") === 0
    ? count
    : null
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
