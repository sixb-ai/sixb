import type { DatasetColumnDefinition, DatasetRow } from "@sixb/core"
import { SixbError } from "@sixb/core/errors"
import type { DatasetVersion, ReadDatasetRowsInput } from "@sixb/core/lake-storage"
import type { DuckLakeStorageOptions } from "../types"
import type { DuckDbQueryRuntime } from "./duckdb-runtime"
import type { DuckLakeConnectionManager } from "./ducklake-connection-manager"
import { type DatasetTableRef, resolveDatasetTableRef } from "./ducklake-dataset-table-ref"
import type { DuckLakeSnapshotReader } from "./ducklake-snapshot-reader"
import { normalizeReadValue } from "./schema"
import { qualifiedTableName, quoteIdentifier } from "./sql"
import { parseVersionId } from "./versions"

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

    const lease = await this.connections.acquireAttachedRuntime()
    try {
      const runtime = lease.runtime

      // Step 1: resolve the physical table from DuckLake metadata directly. Row
      // previews must not go through broad catalog introspection.
      const tableRef = await resolveDatasetTableRef(this.options, runtime, input.datasetId)
      if (!tableRef) {
        throw new SixbError(
          "storage.lake_failed",
          `[SixbDuckLake] Unknown dataset '${input.datasetId}'.`
        )
      }

      const version = await this.resolveVersion(runtime, tableRef, input.versionId)
      const snapshotId = parseVersionId(version.versionId)
      const selectedColumns = this.resolveReadColumns(
        tableRef.datasetId,
        version.schema,
        input.columns
      )

      // Step 2: query DuckLake at the exact snapshot id. Version ids are just
      // `ducklake:<snapshot_id>`, so reads can use native DuckLake time travel
      // directly after validation.
      const columnsSql = selectedColumns.map((column) => quoteIdentifier(column.name)).join(", ")
      const tableSql = qualifiedTableName(this.options, tableRef.tableName)
      // A user column named `rowid` shadows DuckDB's virtual row id. In that edge case the
      // connection-level invariant still preserves insertion order; otherwise make it explicit.
      const orderSql = version.schema.columns.some(
        (column) => column.name.toLowerCase() === "rowid"
      )
        ? ""
        : " ORDER BY rowid"
      const limitSql =
        input.limit === undefined ? "" : ` LIMIT ${Math.max(0, Math.trunc(input.limit))}`
      const offsetSql =
        input.offset === undefined ? "" : ` OFFSET ${Math.max(0, Math.trunc(input.offset))}`
      const sql = `SELECT ${columnsSql} FROM ${tableSql} AT (VERSION => ${snapshotId})${orderSql}${limitSql}${offsetSql}`

      // HTTP previews are bounded, so materialize them eagerly and release the
      // runtime queue as soon as DuckDB has returned the small page.
      const rows = input.limit === undefined ? runtime.streamRows(sql) : await runtime.query(sql)

      // Step 3: DuckDB returns driver-native values. Normalize each projected
      // column through the schema that was active at the resolved version.
      yield* this.normalizeRows(rows, selectedColumns)
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
        throw new SixbError(
          "storage.lake_failed",
          `[SixbDuckLake] Dataset '${datasetId}' does not have column '${columnName}' at the requested version.`
        )
      }

      return column
    })
  }

  private throwNoCommittedVersion(datasetId: string): never {
    throw new SixbError(
      "storage.lake_failed",
      `[SixbDuckLake] No committed version found for dataset '${datasetId}'.`
    )
  }
}
