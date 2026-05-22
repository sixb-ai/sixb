import type { DatasetDefinition, DatasetVersion, DatasetVersionMode } from "@pario/core"
import { LakeStorageError } from "@pario/core"
import type { DuckLakeStorageOptions } from "../types"
import { getBigIntLike, getBoolean, getDate, getString } from "./duckdb-row"
import type { DuckDbRuntime } from "./duckdb-runtime"
import type { DuckLakeConnectionManager } from "./ducklake-connection-manager"
import type { DuckLakeDatasetCatalog } from "./ducklake-dataset-catalog"
import { encodeDatasetTableName } from "./names"
import { duckLakeMetadataTableName, qualifiedTableName, quoteSqlString } from "./sql"
import {
  type ParioCommitMetadata,
  parseCommitMetadata,
  parseInlineDataChange,
  parseVersionId,
  toVersionId,
} from "./versions"

interface DatasetSnapshotRow {
  readonly snapshotId: string
  readonly createdAt: Date
  readonly mode: DatasetVersionMode
  readonly parentSnapshotId?: string
  readonly metadata?: ParioCommitMetadata
}

/**
 * Reconstructs Pario DatasetVersion objects from DuckLake snapshots.
 *
 * DuckLake remains the source of truth for version ids, commit times, and
 * historical reads. Pario commit metadata only hydrates fields DuckLake does
 * not know about, such as producer info and declared inputs.
 *
 * This class intentionally reads DuckLake metadata directly. The provider does
 * not keep a Pario side table for versions; a Pario version is a DuckLake
 * snapshot that either changed the dataset table or was explicitly tagged with
 * Pario dataset metadata.
 */
export class DuckLakeSnapshotReader {
  constructor(
    private readonly options: DuckLakeStorageOptions,
    private readonly connections: DuckLakeConnectionManager,
    private readonly datasets: DuckLakeDatasetCatalog
  ) {}

  async listVersions(datasetId: string, limit?: number): Promise<readonly DatasetVersion[]> {
    this.connections.assertOpen()

    const definition = await this.datasets.getDataset(datasetId)
    if (!definition) {
      return []
    }

    return this.listVersionsForDefinition(await this.connections.runtime(), definition, limit)
  }

  async getLatestVersion(datasetId: string): Promise<DatasetVersion | null> {
    this.connections.assertOpen()

    const definition = await this.datasets.getDataset(datasetId)
    if (!definition) {
      return null
    }

    return this.getLatestVersionForDefinition(await this.connections.runtime(), definition)
  }

  async getVersion(datasetId: string, versionId: string): Promise<DatasetVersion | null> {
    const snapshotId = parseVersionId(versionId)
    this.connections.assertOpen()

    const definition = await this.datasets.getDataset(datasetId)
    if (!definition) {
      return null
    }

    return this.getVersionForSnapshot(await this.connections.runtime(), definition, snapshotId)
  }

  async getLatestVersionForDefinition(
    runtime: DuckDbRuntime,
    dataset: DatasetDefinition
  ): Promise<DatasetVersion | null> {
    const [latest] = await this.listVersionsForDefinition(runtime, dataset, 1)
    return latest ?? null
  }

  async getVersionForSnapshot(
    runtime: DuckDbRuntime,
    dataset: DatasetDefinition,
    snapshotId: string
  ): Promise<DatasetVersion | null> {
    const rows = await this.getSnapshotRows(runtime, dataset.id)
    const match = rows.find((row) => row.snapshotId === snapshotId)
    return match ? this.snapshotToVersion(runtime, dataset, match) : null
  }

  async listVersionsForDefinition(
    runtime: DuckDbRuntime,
    dataset: DatasetDefinition,
    limit?: number
  ): Promise<readonly DatasetVersion[]> {
    const rows = await this.getSnapshotRows(runtime, dataset.id)
    const limitedRows = limit === undefined ? rows : rows.slice(0, Math.max(0, limit))
    const versions: DatasetVersion[] = []

    for (const row of limitedRows) {
      versions.push(await this.snapshotToVersion(runtime, dataset, row))
    }

    return versions
  }

  private async getSnapshotRows(
    runtime: DuckDbRuntime,
    datasetId: string
  ): Promise<readonly DatasetSnapshotRow[]> {
    // Step 1: resolve the current DuckLake table id for the Pario dataset
    // table. Snapshot change metadata is keyed by DuckLake table id, not by
    // user-facing table name.
    const tableName = encodeDatasetTableName(datasetId)
    const tableId = await this.getTableId(runtime, tableName)
    if (tableId === null) {
      return []
    }

    const ducklakeSnapshot = duckLakeMetadataTableName(this.options, "ducklake_snapshot")
    const ducklakeSnapshotChanges = duckLakeMetadataTableName(
      this.options,
      "ducklake_snapshot_changes"
    )
    // Step 2: scan DuckLake snapshots newest-first. Data-change snapshots are
    // always visible for Pario dataset tables. Metadata-only snapshots are
    // visible only when Pario explicitly marked them as dataset commits.
    const rows = await runtime.query(`
      SELECT snapshot.snapshot_id, snapshot.snapshot_time, changes.changes_made, changes.commit_extra_info
      FROM ${ducklakeSnapshot} snapshot
      JOIN ${ducklakeSnapshotChanges} changes
        ON changes.snapshot_id = snapshot.snapshot_id
      ORDER BY snapshot.snapshot_id DESC
    `)

    const snapshots: DatasetSnapshotRow[] = []
    for (const row of rows) {
      const snapshotId = String(getBigIntLike(row, "snapshot_id"))
      const changesMade = getString(row, "changes_made")
      const dataChange = await this.getSnapshotDataChange(runtime, tableId, snapshotId, changesMade)
      const metadata = parseCommitMetadata(row.commit_extra_info)

      // Metadata-only snapshots are common for table comments, schema changes,
      // and other catalog operations. Treat them as dataset versions only when
      // their Pario metadata names this dataset.
      if (!dataChange.hasDataChange) {
        if (metadata?.datasetId !== datasetId) {
          continue
        }

        snapshots.push({
          snapshotId,
          createdAt: getDate(row, "snapshot_time"),
          mode: metadata.mode ?? "schema",
          metadata,
        })
        continue
      }

      // A real data-change snapshot belongs to this dataset because DuckLake's
      // change metadata touched this table id. If Pario metadata is present but
      // points elsewhere, fail loudly rather than hydrating the wrong lineage.
      if (metadata !== undefined && metadata.datasetId !== datasetId) {
        throw new LakeStorageError(
          `[ParioDuckLake] DuckLake snapshot '${snapshotId}' changed dataset '${datasetId}' but Pario commit metadata references dataset '${metadata.datasetId}'.`
        )
      }

      snapshots.push({
        snapshotId,
        createdAt: getDate(row, "snapshot_time"),
        mode: metadata?.mode ?? (dataChange.hasDeleteChange ? "snapshot" : "append"),
        ...(metadata !== undefined ? { metadata } : {}),
      })
    }

    return this.withParentSnapshotIds(snapshots)
  }

  private async getTableId(runtime: DuckDbRuntime, tableName: string): Promise<bigint | null> {
    const ducklakeTable = duckLakeMetadataTableName(this.options, "ducklake_table")
    const [row] = await runtime.query(`
      SELECT table_id
      FROM ${ducklakeTable}
      WHERE table_name = ${quoteSqlString(tableName)}
        AND end_snapshot IS NULL
      LIMIT 1
    `)

    return row === undefined ? null : getBigIntLike(row, "table_id")
  }

  private async getSnapshotDataChange(
    runtime: DuckDbRuntime,
    tableId: bigint,
    snapshotId: string,
    changesMade: string
  ): Promise<{ readonly hasDataChange: boolean; readonly hasDeleteChange: boolean }> {
    // DuckLake records some changes inline in changes_made and some through
    // data/delete file metadata. Check both so external DuckLake writes and
    // Pario writes are interpreted consistently.
    const inlineChange = parseInlineDataChange(changesMade, tableId)
    const ducklakeDataFile = duckLakeMetadataTableName(this.options, "ducklake_data_file")
    const ducklakeDeleteFile = duckLakeMetadataTableName(this.options, "ducklake_delete_file")
    const [row] = await runtime.query(`
      SELECT
        count(*) > 0 AS has_file_change,
        count(*) FILTER (WHERE is_delete_change) > 0 AS has_file_delete_change
      FROM (
        SELECT end_snapshot = ${snapshotId} AS is_delete_change
        FROM ${ducklakeDataFile}
        WHERE table_id = ${tableId}
          AND (begin_snapshot = ${snapshotId} OR end_snapshot = ${snapshotId})
        UNION ALL
        SELECT true AS is_delete_change
        FROM ${ducklakeDeleteFile}
        WHERE table_id = ${tableId}
          AND (begin_snapshot = ${snapshotId} OR end_snapshot = ${snapshotId})
      ) changes
    `)

    const hasFileChange = row ? getBoolean(row, "has_file_change") : false
    const hasFileDeleteChange = row ? getBoolean(row, "has_file_delete_change") : false

    return {
      hasDataChange: inlineChange.hasDataChange || hasFileChange,
      hasDeleteChange: inlineChange.hasDeleteChange || hasFileDeleteChange,
    }
  }

  private async snapshotToVersion(
    runtime: DuckDbRuntime,
    dataset: DatasetDefinition,
    row: DatasetSnapshotRow
  ): Promise<DatasetVersion> {
    const schemaAtSnapshot = await this.datasets.getDatasetSchemaAtSnapshot(
      runtime,
      dataset.id,
      row.snapshotId
    )

    // DuckLake gives us version id, timestamp, and time travel. Pario metadata
    // fills in caller intent such as append vs snapshot and producer lineage.
    // Parent ids and row counts are derived from DuckLake snapshot order and
    // time travel instead of duplicated in commit metadata.
    return {
      datasetId: dataset.id,
      versionId: toVersionId(row.snapshotId),
      parentVersionId:
        row.parentSnapshotId === undefined ? undefined : toVersionId(row.parentSnapshotId),
      mode: row.mode,
      createdAt: row.createdAt,
      schema: schemaAtSnapshot,
      producer: row.metadata?.producer,
      inputs: row.metadata?.inputs,
      rowCount: await this.countRowsAtSnapshot(runtime, dataset, row.snapshotId),
    }
  }

  private async countRowsAtSnapshot(
    runtime: DuckDbRuntime,
    dataset: DatasetDefinition,
    snapshotId: string
  ): Promise<number> {
    const tableName = encodeDatasetTableName(dataset.id)
    const [result] = await runtime.query(
      `SELECT count(*) AS row_count FROM ${qualifiedTableName(
        this.options,
        tableName
      )} AT (VERSION => ${snapshotId})`
    )
    if (result === undefined) {
      return 0
    }

    return Number(getBigIntLike(result, "row_count"))
  }

  private withParentSnapshotIds(
    snapshots: readonly DatasetSnapshotRow[]
  ): readonly DatasetSnapshotRow[] {
    return snapshots.map((snapshot, index) => {
      // Parent ids track versions that reuse the previous dataset state.
      // Snapshot versions replace the rows, so time travel stands on the snapshot id.
      const parentSnapshotId =
        snapshot.mode === "append" || snapshot.mode === "schema"
          ? snapshots[index + 1]?.snapshotId
          : undefined
      return parentSnapshotId === undefined ? snapshot : { ...snapshot, parentSnapshotId }
    })
  }
}
