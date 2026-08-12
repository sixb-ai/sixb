import type { DatasetColumnDefinition, DatasetRow } from "@sixb/core"
import type { DatasetVersion, ReadDatasetRowsInput } from "@sixb/core/lake-storage"
import { LakeStorageError } from "@sixb/core/lake-storage"
import type { DuckLakeStorageOptions } from "../types"
import { getBigIntLike } from "./duckdb-row"
import type { DuckDbQueryRuntime } from "./duckdb-runtime"
import type { DuckLakeConnectionManager } from "./ducklake-connection-manager"
import { type DatasetTableRef, resolveDatasetTableRef } from "./ducklake-dataset-table-ref"
import type { DuckLakeSnapshotReader } from "./ducklake-snapshot-reader"
import { normalizeReadValue } from "./schema"
import { qualifiedTableName, quoteIdentifier } from "./sql"
import { parseVersionId } from "./versions"

// Large reads release the provider's single DuckDB queue slot between bounded pages. Besides
// bounding converted-row memory, this lets a JavaScript pipeline feed one DuckLake dataset into
// another: the destination appender can use the runtime after each page instead of waiting forever
// behind its own still-open source stream.
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
    this.connections.assertOpen()

    // Keep the attachment lease across pages so local catalogs do not pay DETACH/ATTACH for every
    // page. Individual query() calls still release the DuckDB queue before rows are yielded.
    const lease = await this.connections.acquireAttachedRuntime()
    try {
      const runtime = lease.runtime
      // Resolve latest exactly once so a paged read stays pinned even if another writer commits
      // between pages. DuckLake snapshots are immutable; every page names this snapshot.
      const tableRef = await resolveDatasetTableRef(this.options, runtime, input.datasetId)
      if (!tableRef) {
        throw new LakeStorageError(`[SixbDuckLake] Unknown dataset '${input.datasetId}'.`)
      }
      const version = await this.resolveVersion(runtime, tableRef, input.versionId)
      const selectedColumns = this.resolveReadColumns(
        tableRef.datasetId,
        version.schema,
        input.columns
      )
      const snapshotId = parseVersionId(version.versionId)
      const columnsSql = selectedColumns.map((column) => quoteIdentifier(column.name)).join(", ")
      const tableSql = qualifiedTableName(this.options, tableRef.tableName)
      // A user column named `rowid` shadows DuckDB's virtual row id. In that edge case the
      // connection-level invariant still preserves insertion order; otherwise make it explicit.
      const schemaNames = new Set(version.schema.columns.map((column) => column.name.toLowerCase()))
      const canUsePhysicalRowId =
        !schemaNames.has("rowid") && !schemaNames.has(PHYSICAL_ROW_ID_ALIAS.toLowerCase())
      const orderSql = canUsePhysicalRowId ? " ORDER BY rowid" : ""
      const baseSql = `SELECT ${columnsSql} FROM ${tableSql} AT (VERSION => ${snapshotId})`
      const requestedOffset = Math.max(0, Math.trunc(input.offset ?? 0))
      let remaining = input.limit === undefined ? undefined : Math.max(0, Math.trunc(input.limit))
      if (remaining === 0) return

      // Materialize one bounded page and release its queue operation before yielding it. A
      // consumer may enqueue another DuckLake operation while processing the yielded rows.
      // Holding a native stream open here would make that operation wait behind itself.
      let offset = requestedOffset
      let physicalCursor: bigint | null = null
      while (true) {
        const pageRows =
          remaining === undefined ? READ_PAGE_ROWS : Math.min(READ_PAGE_ROWS, remaining)
        const pageSql = canUsePhysicalRowId
          ? `SELECT rowid AS ${quoteIdentifier(PHYSICAL_ROW_ID_ALIAS)}, ${columnsSql}
              FROM ${tableSql} AT (VERSION => ${snapshotId})
              ${physicalCursor === null ? "" : `WHERE rowid > ${physicalCursor}`}
              ORDER BY rowid LIMIT ${pageRows}
              ${physicalCursor === null && offset > 0 ? `OFFSET ${offset}` : ""}`
          : `${baseSql}${orderSql} LIMIT ${pageRows} OFFSET ${offset}`
        const rows = await runtime.query(pageSql)
        if (rows.length === 0) return

        yield* this.normalizeRows(rows, selectedColumns)
        offset += rows.length
        if (remaining !== undefined) {
          remaining -= rows.length
          if (remaining === 0) return
        }
        if (canUsePhysicalRowId) {
          physicalCursor = getBigIntLike(rows[rows.length - 1]!, PHYSICAL_ROW_ID_ALIAS)
        }
        if (rows.length < pageRows) return
      }
    } finally {
      await lease.release()
    }
  }

  private async *normalizeRows(
    rows: Iterable<Record<string, unknown>> | AsyncIterable<Record<string, unknown>>,
    selectedColumns: readonly DatasetColumnDefinition[]
  ): AsyncIterable<DatasetRow> {
    for await (const row of rows) {
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
