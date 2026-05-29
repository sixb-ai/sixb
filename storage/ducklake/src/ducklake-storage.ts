import type {
  BeginDatasetWriteInput,
  DatasetCatalogState,
  DatasetDefinition,
  DatasetRow,
  DatasetVersion,
  LakeStorageWithSql,
  LakeWriteSession,
  ReadDatasetRowsInput,
} from "@pario/core"
import { DuckLakeConnectionManager } from "./internal/ducklake-connection-manager"
import { DuckLakeDatasetCatalog } from "./internal/ducklake-dataset-catalog"
import { DuckLakeRowReader } from "./internal/ducklake-row-reader"
import { DuckLakeSnapshotReader } from "./internal/ducklake-snapshot-reader"
import { DuckLakeSqlExecutor } from "./internal/ducklake-sql-executor"
import { DuckLakeWriteCoordinator } from "./internal/ducklake-write-coordinator"
import type { DuckLakeStorageOptions } from "./types"

/**
 * DuckLake-backed implementation of Pario's LakeStorage API.
 *
 * The public surface stays aligned with core LakeStorage while DuckLake owns
 * physical tables, schemas, snapshots, and transactions behind the provider.
 * Pario-specific metadata is only used to reconstruct DatasetVersion shape.
 */
export class DuckLakeStorage implements LakeStorageWithSql<"duckdb"> {
  readonly standard = { id: "ducklake", version: "1.0" } as const
  readonly sql: DuckLakeSqlExecutor

  private readonly connections: DuckLakeConnectionManager
  private readonly datasets: DuckLakeDatasetCatalog
  private readonly rows: DuckLakeRowReader
  private readonly snapshotReader: DuckLakeSnapshotReader
  private readonly writes: DuckLakeWriteCoordinator

  constructor(options: DuckLakeStorageOptions) {
    const normalizedOptions: DuckLakeStorageOptions = {
      ...options,
      alias: options.alias ?? "pario_lake",
      createIfNotExists: options.createIfNotExists ?? true,
      readOnly: options.readOnly ?? false,
      duckdb: {
        ...options.duckdb,
        path: options.duckdb?.path ?? ":memory:",
      },
    }
    this.connections = new DuckLakeConnectionManager(normalizedOptions)
    this.datasets = new DuckLakeDatasetCatalog(normalizedOptions, this.connections)
    this.snapshotReader = new DuckLakeSnapshotReader(
      normalizedOptions,
      this.connections,
      this.datasets
    )
    this.rows = new DuckLakeRowReader(
      normalizedOptions,
      this.connections,
      this.datasets,
      this.snapshotReader
    )
    this.writes = new DuckLakeWriteCoordinator(
      normalizedOptions,
      this.connections,
      this.datasets,
      this.snapshotReader
    )
    this.sql = new DuckLakeSqlExecutor(
      normalizedOptions,
      this.connections,
      this.datasets,
      this.snapshotReader,
      this.writes
    )
  }

  async createDataset(definition: DatasetDefinition): Promise<DatasetDefinition> {
    return this.datasets.createDataset(definition)
  }

  async assertDatasetDefinitionCompatible(definition: DatasetDefinition): Promise<void> {
    await this.datasets.assertDatasetDefinitionCompatible(definition)
  }

  async getDataset(datasetId: string): Promise<DatasetDefinition | null> {
    return this.datasets.getDataset(datasetId)
  }

  async listDatasets(): Promise<readonly DatasetDefinition[]> {
    return this.datasets.listDatasets()
  }

  async listDatasetCatalogState(
    datasetIds: readonly string[]
  ): Promise<readonly DatasetCatalogState[]> {
    return this.snapshotReader.listDatasetCatalogState(datasetIds)
  }

  async listVersions(datasetId: string, limit?: number): Promise<readonly DatasetVersion[]> {
    return this.snapshotReader.listVersions(datasetId, limit)
  }

  async beginWrite(input: BeginDatasetWriteInput): Promise<LakeWriteSession> {
    return this.writes.beginWrite(input)
  }

  async getLatestVersion(datasetId: string): Promise<DatasetVersion | null> {
    return this.snapshotReader.getLatestVersion(datasetId)
  }

  async getVersion(datasetId: string, versionId: string): Promise<DatasetVersion | null> {
    return this.snapshotReader.getVersion(datasetId, versionId)
  }

  readRows(input: ReadDatasetRowsInput): AsyncIterable<DatasetRow> {
    return this.rows.readRows(input)
  }

  /**
   * `close()` is provider-specific and intentionally not part of the core
   * LakeStorage interface.
   */
  async close(): Promise<void> {
    await this.connections.close()
  }
}
