import type {
  DatasetDefinition,
  DatasetVersion,
  DatasetVersionMode,
  DatasetVersionRef,
} from "@pario/core"
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

interface DatasetSnapshotCandidateRow {
  readonly snapshotId: string
  readonly createdAt: Date
  readonly changesMade: string
  readonly hasFileChange: boolean
  readonly hasFileDeleteChange: boolean
  readonly metadata?: ParioCommitMetadata
}

interface SnapshotCandidateQueryInput {
  readonly tableId: bigint
  readonly exactSnapshotId?: string
  readonly beforeSnapshotId?: string
  readonly limit?: number
}

interface VisibleSnapshotRowsInput {
  readonly datasetId: string
  readonly tableId: bigint
  readonly exactSnapshotId?: string
  readonly beforeSnapshotId?: string
  readonly visibleRowLimit?: number
}

const SNAPSHOT_ROW_BATCH_SIZE = 128

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

  async getLatestVersionRefForDefinition(
    runtime: DuckDbRuntime,
    dataset: DatasetDefinition
  ): Promise<DatasetVersionRef | null> {
    const row = await this.getLatestSnapshotRowForDefinition(runtime, dataset)
    return row ? { datasetId: dataset.id, versionId: toVersionId(row.snapshotId) } : null
  }

  async getVersionForSnapshot(
    runtime: DuckDbRuntime,
    dataset: DatasetDefinition,
    snapshotId: string
  ): Promise<DatasetVersion | null> {
    const match = await this.getSnapshotRowForDefinition(runtime, dataset, snapshotId, {
      includeParent: true,
    })
    return match ? this.snapshotToVersion(runtime, dataset, match) : null
  }

  async getVersionRefForSnapshot(
    runtime: DuckDbRuntime,
    dataset: DatasetDefinition,
    snapshotId: string
  ): Promise<DatasetVersionRef | null> {
    const row = await this.getSnapshotRowForDefinition(runtime, dataset, snapshotId, {
      includeParent: false,
    })
    return row ? { datasetId: dataset.id, versionId: toVersionId(row.snapshotId) } : null
  }

  async listVersionsForDefinition(
    runtime: DuckDbRuntime,
    dataset: DatasetDefinition,
    limit?: number
  ): Promise<readonly DatasetVersion[]> {
    const limitedRows = await this.getSnapshotRowsForDefinition(runtime, dataset, limit)
    const versions: DatasetVersion[] = []

    for (const row of limitedRows) {
      versions.push(await this.snapshotToVersion(runtime, dataset, row))
    }

    return versions
  }

  private async getLatestSnapshotRowForDefinition(
    runtime: DuckDbRuntime,
    dataset: DatasetDefinition
  ): Promise<DatasetSnapshotRow | null> {
    const tableName = encodeDatasetTableName(dataset.id)
    const tableId = await this.getTableId(runtime, tableName)
    if (tableId === null) {
      return null
    }

    const [row] = await this.collectVisibleSnapshotRows(runtime, {
      datasetId: dataset.id,
      tableId,
      visibleRowLimit: 1,
    })
    return row ?? null
  }

  private async getSnapshotRowForDefinition(
    runtime: DuckDbRuntime,
    dataset: DatasetDefinition,
    snapshotId: string,
    options: { readonly includeParent: boolean }
  ): Promise<DatasetSnapshotRow | null> {
    assertDuckLakeSnapshotId(snapshotId)

    const tableName = encodeDatasetTableName(dataset.id)
    const tableId = await this.getTableId(runtime, tableName)
    if (tableId === null) {
      return null
    }

    const [row] = await this.collectVisibleSnapshotRows(runtime, {
      datasetId: dataset.id,
      tableId,
      exactSnapshotId: snapshotId,
      visibleRowLimit: 1,
    })
    if (!row) {
      return null
    }

    if (!options.includeParent || (row.mode !== "append" && row.mode !== "schema")) {
      return row
    }

    const [parent] = await this.collectVisibleSnapshotRows(runtime, {
      datasetId: dataset.id,
      tableId,
      beforeSnapshotId: snapshotId,
      visibleRowLimit: 1,
    })

    return parent ? { ...row, parentSnapshotId: parent.snapshotId } : row
  }

  private async getSnapshotRowsForDefinition(
    runtime: DuckDbRuntime,
    dataset: DatasetDefinition,
    limit?: number
  ): Promise<readonly DatasetSnapshotRow[]> {
    const visibleLimit = limit === undefined ? undefined : Math.max(0, limit)
    if (visibleLimit === 0) {
      return []
    }

    const tableName = encodeDatasetTableName(dataset.id)
    const tableId = await this.getTableId(runtime, tableName)
    if (tableId === null) {
      return []
    }

    const rows = await this.collectVisibleSnapshotRows(runtime, {
      datasetId: dataset.id,
      tableId,
      visibleRowLimit: visibleLimit === undefined ? undefined : visibleLimit + 1,
    })
    const rowsWithParents = this.withParentSnapshotIds(rows)
    return visibleLimit === undefined ? rowsWithParents : rowsWithParents.slice(0, visibleLimit)
  }

  private async collectVisibleSnapshotRows(
    runtime: DuckDbRuntime,
    input: VisibleSnapshotRowsInput
  ): Promise<readonly DatasetSnapshotRow[]> {
    if (input.visibleRowLimit !== undefined && input.visibleRowLimit <= 0) {
      return []
    }

    const snapshots: DatasetSnapshotRow[] = []
    let beforeSnapshotId = input.beforeSnapshotId

    while (input.visibleRowLimit === undefined || snapshots.length < input.visibleRowLimit) {
      const candidates = await this.querySnapshotCandidates(runtime, {
        tableId: input.tableId,
        exactSnapshotId: input.exactSnapshotId,
        beforeSnapshotId,
        limit: input.exactSnapshotId === undefined ? SNAPSHOT_ROW_BATCH_SIZE : 1,
      })
      if (candidates.length === 0) {
        break
      }

      for (const candidate of candidates) {
        const snapshot = this.candidateToSnapshotRow(input.datasetId, input.tableId, candidate)
        if (snapshot) {
          snapshots.push(snapshot)
        }

        if (input.visibleRowLimit !== undefined && snapshots.length >= input.visibleRowLimit) {
          break
        }
      }

      if (input.exactSnapshotId !== undefined || candidates.length < SNAPSHOT_ROW_BATCH_SIZE) {
        break
      }

      beforeSnapshotId = candidates[candidates.length - 1]?.snapshotId
    }

    return snapshots
  }

  private async querySnapshotCandidates(
    runtime: DuckDbRuntime,
    input: SnapshotCandidateQueryInput
  ): Promise<readonly DatasetSnapshotCandidateRow[]> {
    if (input.limit !== undefined && input.limit <= 0) {
      return []
    }

    const where: string[] = []
    if (input.exactSnapshotId !== undefined) {
      assertDuckLakeSnapshotId(input.exactSnapshotId)
      where.push(`snapshot.snapshot_id = ${input.exactSnapshotId}`)
    }
    if (input.beforeSnapshotId !== undefined) {
      assertDuckLakeSnapshotId(input.beforeSnapshotId)
      where.push(`snapshot.snapshot_id < ${input.beforeSnapshotId}`)
    }

    const whereSql = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`
    const limitSql =
      input.limit === undefined ? "" : `LIMIT ${Math.max(0, Math.trunc(input.limit))}`
    const ducklakeSnapshot = duckLakeMetadataTableName(this.options, "ducklake_snapshot")
    const ducklakeSnapshotChanges = duckLakeMetadataTableName(
      this.options,
      "ducklake_snapshot_changes"
    )
    const ducklakeDataFile = duckLakeMetadataTableName(this.options, "ducklake_data_file")
    const ducklakeDeleteFile = duckLakeMetadataTableName(this.options, "ducklake_delete_file")

    const rows = await runtime.query(`
      WITH candidate_snapshots AS (
        -- Recent DuckLake snapshots to inspect; Pario visibility is filtered later.
        SELECT
          snapshot.snapshot_id,
          snapshot.snapshot_time,
          changes.changes_made,
          changes.commit_extra_info
        FROM ${ducklakeSnapshot} snapshot
        JOIN ${ducklakeSnapshotChanges} changes
          ON changes.snapshot_id = snapshot.snapshot_id
        ${whereSql}
        ORDER BY snapshot.snapshot_id DESC
        ${limitSql}
      ),
      file_changes AS (
        -- File metadata tells whether this table changed in each candidate snapshot.
        SELECT begin_snapshot AS snapshot_id, false AS is_delete_change
        FROM ${ducklakeDataFile}
        WHERE table_id = ${input.tableId}
          AND begin_snapshot IN (SELECT snapshot_id FROM candidate_snapshots)
        UNION ALL
        SELECT end_snapshot AS snapshot_id, true AS is_delete_change
        FROM ${ducklakeDataFile}
        WHERE table_id = ${input.tableId}
          AND end_snapshot IN (SELECT snapshot_id FROM candidate_snapshots)
        UNION ALL
        SELECT begin_snapshot AS snapshot_id, true AS is_delete_change
        FROM ${ducklakeDeleteFile}
        WHERE table_id = ${input.tableId}
          AND begin_snapshot IN (SELECT snapshot_id FROM candidate_snapshots)
        UNION ALL
        SELECT end_snapshot AS snapshot_id, true AS is_delete_change
        FROM ${ducklakeDeleteFile}
        WHERE table_id = ${input.tableId}
          AND end_snapshot IN (SELECT snapshot_id FROM candidate_snapshots)
      ),
      file_changes_by_snapshot AS (
        -- Collapse file-level changes into one row per snapshot.
        SELECT
          snapshot_id,
          count(*) > 0 AS has_file_change,
          count(*) FILTER (WHERE is_delete_change) > 0 AS has_file_delete_change
        FROM file_changes
        GROUP BY snapshot_id
      )
      SELECT
        -- Keep metadata-only candidates; Pario filters them with commit_extra_info.
        candidate.snapshot_id,
        candidate.snapshot_time,
        candidate.changes_made,
        candidate.commit_extra_info,
        coalesce(file_changes.has_file_change, false) AS has_file_change,
        coalesce(file_changes.has_file_delete_change, false) AS has_file_delete_change
      FROM candidate_snapshots candidate
      LEFT JOIN file_changes_by_snapshot file_changes
        ON file_changes.snapshot_id = candidate.snapshot_id
      ORDER BY candidate.snapshot_id DESC
    `)

    return rows.map((row) => {
      const metadata = parseCommitMetadata(row.commit_extra_info)
      return {
        snapshotId: String(getBigIntLike(row, "snapshot_id")),
        createdAt: getDate(row, "snapshot_time"),
        changesMade: getString(row, "changes_made"),
        hasFileChange: getBoolean(row, "has_file_change"),
        hasFileDeleteChange: getBoolean(row, "has_file_delete_change"),
        ...(metadata !== undefined ? { metadata } : {}),
      }
    })
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

  private candidateToSnapshotRow(
    datasetId: string,
    tableId: bigint,
    candidate: DatasetSnapshotCandidateRow
  ): DatasetSnapshotRow | null {
    const inlineChange = parseInlineDataChange(candidate.changesMade, tableId)
    const hasDataChange = inlineChange.hasDataChange || candidate.hasFileChange
    const hasDeleteChange = inlineChange.hasDeleteChange || candidate.hasFileDeleteChange

    // Metadata-only snapshots are common for table comments, schema changes,
    // and other catalog operations. Treat them as dataset versions only when
    // their Pario metadata names this dataset.
    if (!hasDataChange) {
      const metadata = candidate.metadata
      if (!metadata || metadata.datasetId !== datasetId) {
        return null
      }

      return {
        snapshotId: candidate.snapshotId,
        createdAt: candidate.createdAt,
        mode: metadata.mode ?? "schema",
        metadata,
      }
    }

    // A real data-change snapshot belongs to this dataset because DuckLake's
    // change metadata touched this table id. If Pario metadata is present but
    // points elsewhere, fail loudly rather than hydrating the wrong lineage.
    if (candidate.metadata !== undefined && candidate.metadata.datasetId !== datasetId) {
      throw new LakeStorageError(
        `[ParioDuckLake] DuckLake snapshot '${candidate.snapshotId}' changed dataset '${datasetId}' but Pario commit metadata references dataset '${candidate.metadata.datasetId}'.`
      )
    }

    return {
      snapshotId: candidate.snapshotId,
      createdAt: candidate.createdAt,
      mode: candidate.metadata?.mode ?? (hasDeleteChange ? "snapshot" : "append"),
      ...(candidate.metadata !== undefined ? { metadata: candidate.metadata } : {}),
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

function assertDuckLakeSnapshotId(snapshotId: string): void {
  if (!/^\d+$/.test(snapshotId)) {
    throw new LakeStorageError(`[ParioDuckLake] Invalid DuckLake snapshot id '${snapshotId}'.`)
  }
}
