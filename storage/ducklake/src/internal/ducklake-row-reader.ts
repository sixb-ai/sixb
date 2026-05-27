import type {
  DatasetColumnDefinition,
  DatasetDefinition,
  DatasetRow,
  DatasetVersion,
  ReadDatasetRowsInput,
} from "@pario/core"
import { LakeStorageError } from "@pario/core"
import type { DuckLakeStorageOptions } from "../types"
import type { DuckDbRuntime } from "./duckdb-runtime"
import type { DuckLakeConnectionManager } from "./ducklake-connection-manager"
import type { DuckLakeDatasetCatalog } from "./ducklake-dataset-catalog"
import type { DuckLakeSnapshotReader } from "./ducklake-snapshot-reader"
import { encodeDatasetTableName } from "./names"
import { normalizeReadValue } from "./schema"
import { qualifiedTableName, quoteIdentifier } from "./sql"
import { parseVersionId } from "./versions"

/**
 * Reads dataset rows from DuckLake snapshots.
 *
 * This module owns the last mile of reads: resolve the requested Pario version
 * to a DuckLake snapshot id, render a DuckLake time-travel query, and normalize
 * DuckDB values back into Pario row shape.
 */
export class DuckLakeRowReader {
  constructor(
    private readonly options: DuckLakeStorageOptions,
    private readonly connections: DuckLakeConnectionManager,
    private readonly datasets: DuckLakeDatasetCatalog,
    private readonly snapshots: DuckLakeSnapshotReader
  ) {}

  async *readRows(input: ReadDatasetRowsInput): AsyncIterable<DatasetRow> {
    this.connections.assertOpen()

    // Step 1: use the catalog definition, not caller-provided shape. That
    // keeps projection validation and value normalization aligned with the
    // physical DuckLake table.
    const definition = await this.datasets.getDataset(input.datasetId)
    if (!definition) {
      throw new LakeStorageError(`[ParioDuckLake] Unknown dataset '${input.datasetId}'.`)
    }

    const runtime = await this.connections.runtime()
    const version = await this.resolveVersion(runtime, definition, input.versionId)
    const snapshotId = parseVersionId(version.versionId)
    const selectedColumns = this.resolveReadColumns(definition.id, version.schema, input.columns)

    // Step 2: query DuckLake at the exact snapshot id. Version ids are just
    // `ducklake:<snapshot_id>`, so reads can use native DuckLake time travel
    // directly after validation.
    const tableName = encodeDatasetTableName(input.datasetId)
    const columnsSql = selectedColumns.map((column) => quoteIdentifier(column.name)).join(", ")
    const tableSql = qualifiedTableName(this.options, tableName)
    const limitSql = input.limit === undefined ? "" : ` LIMIT ${Math.max(0, input.limit)}`
    const offsetSql = input.offset === undefined ? "" : ` OFFSET ${Math.max(0, input.offset)}`
    const rows = runtime.streamRows(
      `SELECT ${columnsSql} FROM ${tableSql} AT (VERSION => ${snapshotId})${limitSql}${offsetSql}`
    )

    // Step 3: DuckDB returns driver-native values. Normalize each projected
    // column through the schema that was active at the resolved version.
    for await (const row of rows) {
      const output: Record<string, unknown> = {}
      for (const column of selectedColumns) {
        output[column.name] = normalizeReadValue(row[column.name], column)
      }
      yield output
    }
  }

  private async resolveVersion(
    runtime: DuckDbRuntime,
    definition: DatasetDefinition,
    versionId?: string
  ): Promise<DatasetVersion> {
    if (versionId !== undefined) {
      const snapshotId = parseVersionId(versionId)
      const version = await this.snapshots.getVersionForSnapshot(runtime, definition, snapshotId)
      if (!version) {
        this.throwNoCommittedVersion(definition.id)
      }

      return version
    }

    const latestVersion = await this.snapshots.getLatestVersionForDefinition(runtime, definition)
    if (!latestVersion) {
      this.throwNoCommittedVersion(definition.id)
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
          `[ParioDuckLake] Dataset '${datasetId}' does not have column '${columnName}' at the requested version.`
        )
      }

      return column
    })
  }

  private throwNoCommittedVersion(datasetId: string): never {
    throw new LakeStorageError(
      `[ParioDuckLake] No committed version found for dataset '${datasetId}'.`
    )
  }
}
