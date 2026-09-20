import type { DatasetColumnDefinition, DatasetRow } from "@sixb/core"
import type { DatasetVersion, ReadDatasetRowsInput } from "@sixb/core/lake-storage"
import { LakeStorageError } from "@sixb/core/lake-storage"
import type { DuckLakeStorageOptions } from "../types"
import type { DuckDbReader } from "./duckdb-reader"
import { getBigIntLike } from "./duckdb-row"
import type { DuckDbQueryRuntime } from "./duckdb-runtime"
import type { DuckLakeConnectionManager } from "./ducklake-connection-manager"
import { type DatasetTableRef, resolveDatasetTableRef } from "./ducklake-dataset-table-ref"
import type { DuckLakeSnapshotReader } from "./ducklake-snapshot-reader"
import { normalizeReadValue } from "./schema"
import { qualifiedTableName, quoteIdentifier } from "./sql"
import { parseVersionId } from "./versions"

// Bounded fallback for catalogs whose metadata transactions cannot stay open during a read.
const READ_PAGE_ROWS = 5_000
const PHYSICAL_ROW_ID_ALIAS = "__sixb_physical_row_id"

/**
 * Reads dataset rows from DuckLake snapshots.
 *
 * This module owns the last mile of reads: resolve the requested Sixb version
 * to a DuckLake snapshot id, render a DuckLake time-travel query, and normalize
 * DuckDB values back into Sixb row shape.
 */
export class DuckLakeRowReader {
  constructor(
    private readonly options: DuckLakeStorageOptions,
    private readonly connections: DuckLakeConnectionManager,
    private readonly snapshots: DuckLakeSnapshotReader
  ) {}

  async *readRows(input: ReadDatasetRowsInput): AsyncIterable<DatasetRow> {
    const read = await this.connections.acquireRead(input.signal)
    let reader: DuckDbReader | null = null
    try {
      const prepared = await this.connections.withAttachedRuntime(async (runtime) => {
        read.signal.throwIfAborted()
        const tableRef = await resolveDatasetTableRef(this.options, runtime, input.datasetId)
        if (!tableRef) {
          throw new LakeStorageError(`[SixbDuckLake] Unknown dataset '${input.datasetId}'.`)
        }
        // Resolve latest once, before yielding any rows. Every query names the same snapshot.
        const version = await this.resolveVersion(runtime, tableRef, input.versionId)
        const columns = this.resolveReadColumns(tableRef.datasetId, version.schema, input.columns)
        const names = new Set(version.schema.columns.map((column) => column.name.toLowerCase()))
        const physicalOrder = !names.has("rowid") && !names.has(PHYSICAL_ROW_ID_ALIAS)
        const relation = `${qualifiedTableName(this.options, tableRef.tableName)} AT (VERSION => ${parseVersionId(version.versionId)})`
        const columnsSql = columns.map((column) => quoteIdentifier(column.name)).join(", ")
        const offset = Math.max(0, Math.trunc(input.offset ?? 0))
        const limit = input.limit === undefined ? undefined : Math.max(0, Math.trunc(input.limit))
        const sql = `SELECT ${columnsSql} FROM ${relation}${physicalOrder ? " ORDER BY rowid" : ""}${limit === undefined ? "" : ` LIMIT ${limit}`}${offset > 0 ? ` OFFSET ${offset}` : ""}`
        const cursor =
          limit === undefined || limit > READ_PAGE_ROWS
            ? await this.connections.openReader(runtime, sql, read.signal, read.release)
            : null
        const query = { columnsSql, relation, physicalOrder }
        const firstPage =
          cursor || limit === 0
            ? []
            : await runtime.query(
                pageSql(query, Math.min(limit ?? READ_PAGE_ROWS, READ_PAGE_ROWS), offset, null)
              )
        return { columns, ...query, offset, limit, cursor, firstPage }
      })
      reader = prepared.cursor
      // A paused paged reader owns no native query. Cancellation can release its read lease without
      // waiting for the consumer to call next()/return(); native readers release after cleanup.
      if (!reader) read.signal.addEventListener("abort", read.release, { once: true })
      read.signal.throwIfAborted()
      if (reader) {
        yield* this.normalizeRows(reader.rows(), prepared.columns, read.signal)
        return
      }

      // Each bounded query releases both the runtime queue and attachment lease before yielding.
      // SQLite metadata locks and PostgreSQL pool slots are released before consumer operations.
      let offset = prepared.offset
      let remaining = prepared.limit
      let cursor: bigint | null = null
      let page: readonly Record<string, unknown>[] | undefined = prepared.firstPage
      while (remaining !== 0) {
        read.signal.throwIfAborted()
        const pageSize = Math.min(remaining ?? READ_PAGE_ROWS, READ_PAGE_ROWS)
        const rows: readonly Record<string, unknown>[] =
          page ??
          (await this.connections.withAttachedRuntime((runtime) =>
            runtime.query(pageSql(prepared, pageSize, offset, cursor))
          ))
        page = undefined
        read.signal.throwIfAborted()
        yield* this.normalizeRows(rows, prepared.columns, read.signal)
        if (remaining !== undefined) remaining -= rows.length
        if (rows.length < pageSize) return
        if (prepared.physicalOrder)
          cursor = getBigIntLike(rows[rows.length - 1]!, PHYSICAL_ROW_ID_ALIAS)
        offset += rows.length
      }
    } finally {
      read.signal.removeEventListener("abort", read.release)
      try {
        await reader?.close()
      } finally {
        read.release()
      }
    }
  }

  private async *normalizeRows(
    rows: Iterable<Record<string, unknown>> | AsyncIterable<Record<string, unknown>>,
    selectedColumns: readonly DatasetColumnDefinition[],
    signal: AbortSignal
  ): AsyncIterable<DatasetRow> {
    for await (const row of rows) {
      signal.throwIfAborted()
      const output: Record<string, unknown> = {}
      for (const column of selectedColumns) {
        output[column.name] = normalizeReadValue(row[column.name], column)
      }
      yield output
    }
  }

  private async resolveVersion(
    runtime: DuckDbQueryRuntime,
    tableRef: DatasetTableRef,
    versionId?: string
  ): Promise<DatasetVersion> {
    if (versionId !== undefined) {
      const snapshotId = parseVersionId(versionId)
      const version = await this.snapshots.getVersionForTableRef(runtime, tableRef, snapshotId)
      if (!version) {
        this.throwNoCommittedVersion(tableRef.datasetId)
      }

      return version
    }

    const latestVersion = await this.snapshots.getLatestVersionForTableRef(runtime, tableRef)
    if (!latestVersion) {
      this.throwNoCommittedVersion(tableRef.datasetId)
    }

    return latestVersion
  }

  private resolveReadColumns(
    datasetId: string,
    schema: DatasetVersion["schema"],
    columns?: readonly string[]
  ): readonly DatasetColumnDefinition[] {
    if (columns === undefined || columns.length === 0) {
      return schema.columns
    }

    const columnsByName = new Map(schema.columns.map((column) => [column.name, column] as const))

    return columns.map((columnName) => {
      const column = columnsByName.get(columnName)
      if (!column) {
        throw new LakeStorageError(
          `[SixbDuckLake] Dataset '${datasetId}' does not have column '${columnName}' at the requested version.`
        )
      }

      return column
    })
  }

  private throwNoCommittedVersion(datasetId: string): never {
    throw new LakeStorageError(
      `[SixbDuckLake] No committed version found for dataset '${datasetId}'.`
    )
  }
}

function pageSql(
  read: { readonly columnsSql: string; readonly relation: string; readonly physicalOrder: boolean },
  limit: number,
  offset: number,
  cursor: bigint | null
): string {
  return read.physicalOrder
    ? `SELECT rowid AS ${quoteIdentifier(PHYSICAL_ROW_ID_ALIAS)}, ${read.columnsSql}
        FROM ${read.relation} ${cursor === null ? "" : `WHERE rowid > ${cursor}`}
        ORDER BY rowid LIMIT ${limit} ${cursor === null && offset > 0 ? `OFFSET ${offset}` : ""}`
    : `SELECT ${read.columnsSql} FROM ${read.relation} LIMIT ${limit} OFFSET ${offset}`
}
