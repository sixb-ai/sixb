import type { DatasetDefinition } from "@sixb/core"
import type {
  DatasetCatalogState,
  DatasetLatestVersionSummary,
  DatasetVersion,
  DatasetVersionMode,
  DatasetVersionRef,
} from "@sixb/core/lake-storage"
import { LakeStorageError } from "@sixb/core/lake-storage"
import type { DuckLakeStorageOptions } from "../types"
import { getBigIntLike, getBoolean, getDate, getOptionalString, getString } from "./duckdb-row"
import type { DuckDbQueryRuntime } from "./duckdb-runtime"
import type { DuckLakeConnectionManager } from "./ducklake-connection-manager"
import type { DuckLakeDatasetCatalog } from "./ducklake-dataset-catalog"
import { type DatasetTableRef, resolveDatasetTableRef } from "./ducklake-dataset-table-ref"
import { encodeDatasetTableName } from "./names"
import { duckLakeMetadataTableName, quoteSqlString } from "./sql"
import {
  parseCommitMetadata,
  parseInlineDataChange,
  parseVersionId,
  type SixbCommitMetadata,
  toVersionId,
} from "./versions"

interface DatasetSnapshotRow {
  readonly snapshotId: string
  readonly tableId: bigint
  readonly createdAt: Date
  readonly mode: DatasetVersionMode
  readonly parentSnapshotId?: string
  readonly metadata?: SixbCommitMetadata
}

interface DatasetSnapshotCandidateRow {
  readonly snapshotId: string
  readonly createdAt: Date
  readonly changesMade: string
  readonly hasFileChange: boolean
  readonly hasFileDeleteChange: boolean
  readonly metadata?: SixbCommitMetadata
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

export interface DuckLakeVersionSummary {
  readonly datasetId: string
  readonly versionId: string
  readonly rowCount?: number
}

/** One snapshot row from the shared catalog scan, before per-dataset filtering. */
interface CatalogScanSnapshot {
  readonly snapshotId: string
  readonly createdAt: Date
  readonly changesMade: string
  readonly metadata?: SixbCommitMetadata
}

/** Per (snapshot, table) file-change flags merged into the catalog scan. */
interface FileChangeFlags {
  readonly hasFileChange: boolean
  readonly hasFileDeleteChange: boolean
}

const SNAPSHOT_ROW_BATCH_SIZE = 128

// The bulk catalog scan shares one descending walk of recent snapshots across
// all requested datasets, so its cost is bounded by this window rather than by
// the dataset count. A dataset whose latest version is older than the window
// reports a null latest version, which is acceptable for a catalog summary; the
// detail routes still hydrate exact history.
const CATALOG_SNAPSHOT_SCAN_LIMIT = 512

/**
 * Reconstructs Sixb DatasetVersion objects from DuckLake snapshots.
 *
 * DuckLake remains the source of truth for version ids, commit times, and
 * historical reads. Sixb commit metadata only hydrates fields DuckLake does
 * not know about, such as producer info and declared inputs.
 *
 * This class intentionally reads DuckLake metadata directly. The provider does
 * not keep a Sixb side table for versions; a Sixb version is a DuckLake
 * snapshot that either changed the dataset table or was explicitly tagged with
 * Sixb dataset metadata.
 */
export class DuckLakeSnapshotReader {
  constructor(
    private readonly options: DuckLakeStorageOptions,
    private readonly connections: DuckLakeConnectionManager,
    private readonly datasets: DuckLakeDatasetCatalog
  ) {}

  async listVersions(datasetId: string, limit?: number): Promise<readonly DatasetVersion[]> {
    this.connections.assertOpen()

    return this.connections.withAttachedRuntime(async (runtime) => {
      const tableRef = await resolveDatasetTableRef(this.options, runtime, datasetId)
      if (!tableRef) {
        return []
      }

      return this.listVersionsForTableRef(runtime, tableRef, limit)
    })
  }

  async getLatestVersion(datasetId: string): Promise<DatasetVersion | null> {
    this.connections.assertOpen()

    return this.connections.withAttachedRuntime(async (runtime) => {
      const tableRef = await resolveDatasetTableRef(this.options, runtime, datasetId)
      if (!tableRef) {
        return null
      }

      return this.getLatestVersionForTableRef(runtime, tableRef)
    })
  }

  async getVersion(datasetId: string, versionId: string): Promise<DatasetVersion | null> {
    const snapshotId = parseVersionId(versionId)
    this.connections.assertOpen()

    return this.connections.withAttachedRuntime(async (runtime) => {
      const tableRef = await resolveDatasetTableRef(this.options, runtime, datasetId)
      if (!tableRef) {
        return null
      }

      return this.getVersionForTableRef(runtime, tableRef, snapshotId)
    })
  }

  /**
   * Bulk catalog-summary read used by the dataset list view.
   *
   * Resolves materialized state and a lightweight latest-version summary for
   * many datasets with a bounded number of metadata queries, never one snapshot
   * scan per dataset and never a count(*) over dataset contents.
   */
  async listDatasetCatalogState(
    datasetIds: readonly string[]
  ): Promise<readonly DatasetCatalogState[]> {
    this.connections.assertOpen()

    if (datasetIds.length === 0) {
      return []
    }

    return this.connections.withAttachedRuntime((runtime) =>
      this.collectDatasetCatalogState(runtime, datasetIds)
    )
  }

  private async collectDatasetCatalogState(
    runtime: DuckDbQueryRuntime,
    datasetIds: readonly string[]
  ): Promise<readonly DatasetCatalogState[]> {
    const uniqueIds = [...new Set(datasetIds)]
    const tableIdsByDatasetId = await this.resolveDatasetTableIds(runtime, uniqueIds)
    const latestRowByDatasetId = await this.resolveLatestSnapshotRows(runtime, tableIdsByDatasetId)

    return uniqueIds.map((datasetId) => {
      if (!tableIdsByDatasetId.has(datasetId)) {
        return { datasetId, materialized: false, latestVersion: null }
      }

      const row = latestRowByDatasetId.get(datasetId)
      return {
        datasetId,
        materialized: true,
        latestVersion: row ? this.snapshotRowToSummary(datasetId, row) : null,
      }
    })
  }

  private snapshotRowToSummary(
    datasetId: string,
    row: DatasetSnapshotRow
  ): DatasetLatestVersionSummary {
    return {
      datasetId,
      versionId: toVersionId(row.snapshotId),
      mode: row.mode,
      createdAt: row.createdAt,
      ...(row.metadata?.rowCount !== undefined ? { rowCount: row.metadata.rowCount } : {}),
    }
  }

  private async resolveDatasetTableIds(
    runtime: DuckDbQueryRuntime,
    datasetIds: readonly string[]
  ): Promise<Map<string, bigint>> {
    // Encoded table names are a collision-free bijection with dataset ids, so a
    // single `ducklake_table` read maps every requested id to its current table.
    const datasetIdByTableName = new Map<string, string>()
    for (const datasetId of datasetIds) {
      datasetIdByTableName.set(encodeDatasetTableName(datasetId), datasetId)
    }

    const ducklakeTable = duckLakeMetadataTableName(this.options, "ducklake_table")
    const tableNameList = [...datasetIdByTableName.keys()]
      .map((name) => quoteSqlString(name))
      .join(", ")
    const rows = await runtime.query(`
      SELECT table_id, table_name
      FROM ${ducklakeTable}
      WHERE table_name IN (${tableNameList})
        AND end_snapshot IS NULL
    `)

    const tableIdsByDatasetId = new Map<string, bigint>()
    for (const row of rows) {
      const datasetId = datasetIdByTableName.get(getString(row, "table_name"))
      if (datasetId !== undefined) {
        tableIdsByDatasetId.set(datasetId, getBigIntLike(row, "table_id"))
      }
    }

    return tableIdsByDatasetId
  }

  /**
   * Resolve each dataset's latest snapshot row with one shared descending walk.
   *
   * The walk reuses {@link candidateToSnapshotRow} so Sixb visibility, mode
   * derivation, and the loud conflict rule match exact version hydration. Cost
   * is bounded by the snapshot window, not by the number of datasets.
   */
  private async resolveLatestSnapshotRows(
    runtime: DuckDbQueryRuntime,
    tableIdsByDatasetId: ReadonlyMap<string, bigint>
  ): Promise<Map<string, DatasetSnapshotRow>> {
    const result = new Map<string, DatasetSnapshotRow>()
    if (tableIdsByDatasetId.size === 0) {
      return result
    }

    const unresolved = new Map<string, bigint>(tableIdsByDatasetId)
    const tableIds = [...new Set(tableIdsByDatasetId.values())]

    let beforeSnapshotId: string | undefined
    let scanned = 0
    while (unresolved.size > 0 && scanned < CATALOG_SNAPSHOT_SCAN_LIMIT) {
      const candidates = await this.queryCatalogSnapshotBatch(
        runtime,
        beforeSnapshotId,
        SNAPSHOT_ROW_BATCH_SIZE
      )
      if (candidates.length === 0) {
        break
      }

      const fileFlags = await this.queryFileChangeFlags(
        runtime,
        candidates.map((candidate) => candidate.snapshotId),
        tableIds
      )

      for (const candidate of candidates) {
        scanned += 1
        for (const [datasetId, tableId] of [...unresolved]) {
          const flags = fileFlags.get(fileChangeKey(candidate.snapshotId, tableId))
          const row = this.candidateToSnapshotRow(datasetId, tableId, {
            snapshotId: candidate.snapshotId,
            createdAt: candidate.createdAt,
            changesMade: candidate.changesMade,
            hasFileChange: flags?.hasFileChange ?? false,
            hasFileDeleteChange: flags?.hasFileDeleteChange ?? false,
            ...(candidate.metadata !== undefined ? { metadata: candidate.metadata } : {}),
          })
          if (row) {
            result.set(datasetId, row)
            unresolved.delete(datasetId)
          }
        }

        if (unresolved.size === 0) {
          break
        }
      }

      if (candidates.length < SNAPSHOT_ROW_BATCH_SIZE) {
        break
      }
      beforeSnapshotId = candidates[candidates.length - 1]?.snapshotId
    }

    return result
  }

  private async queryCatalogSnapshotBatch(
    runtime: DuckDbQueryRuntime,
    beforeSnapshotId: string | undefined,
    limit: number
  ): Promise<readonly CatalogScanSnapshot[]> {
    const ducklakeSnapshot = duckLakeMetadataTableName(this.options, "ducklake_snapshot")
    const ducklakeSnapshotChanges = duckLakeMetadataTableName(
      this.options,
      "ducklake_snapshot_changes"
    )

    let whereSql = ""
    if (beforeSnapshotId !== undefined) {
      assertDuckLakeSnapshotId(beforeSnapshotId)
      whereSql = `WHERE snapshot.snapshot_id < ${beforeSnapshotId}`
    }

    const rows = await runtime.query(`
      SELECT
        snapshot.snapshot_id,
        snapshot.snapshot_time,
        changes.changes_made,
        changes.commit_extra_info
      FROM ${ducklakeSnapshot} snapshot
      JOIN ${ducklakeSnapshotChanges} changes ON changes.snapshot_id = snapshot.snapshot_id
      ${whereSql}
      ORDER BY snapshot.snapshot_id DESC
      LIMIT ${Math.max(0, Math.trunc(limit))}
    `)

    return rows.map((row) => {
      const metadata = parseCommitMetadata(getOptionalString(row, "commit_extra_info"))
      return {
        snapshotId: String(getBigIntLike(row, "snapshot_id")),
        createdAt: getDate(row, "snapshot_time"),
        changesMade: getString(row, "changes_made"),
        ...(metadata !== undefined ? { metadata } : {}),
      }
    })
  }

  private async queryFileChangeFlags(
    runtime: DuckDbQueryRuntime,
    snapshotIds: readonly string[],
    tableIds: readonly bigint[]
  ): Promise<Map<string, FileChangeFlags>> {
    const flags = new Map<string, FileChangeFlags>()
    if (snapshotIds.length === 0 || tableIds.length === 0) {
      return flags
    }

    for (const snapshotId of snapshotIds) {
      assertDuckLakeSnapshotId(snapshotId)
    }

    const snapshotIdList = snapshotIds.join(", ")
    const tableIdList = tableIds.map((tableId) => tableId.toString()).join(", ")
    const ducklakeDataFile = duckLakeMetadataTableName(this.options, "ducklake_data_file")
    const ducklakeDeleteFile = duckLakeMetadataTableName(this.options, "ducklake_delete_file")

    // Large tables keep their changes in data/delete files instead of inline
    // `changes_made`, so merge file-level changes for the scanned snapshots.
    const rows = await runtime.query(`
      WITH file_changes AS (
        SELECT begin_snapshot AS snapshot_id, table_id, false AS is_delete
        FROM ${ducklakeDataFile}
        WHERE table_id IN (${tableIdList}) AND begin_snapshot IN (${snapshotIdList})
        UNION ALL
        SELECT end_snapshot, table_id, true
        FROM ${ducklakeDataFile}
        WHERE table_id IN (${tableIdList}) AND end_snapshot IN (${snapshotIdList})
        UNION ALL
        SELECT begin_snapshot, table_id, true
        FROM ${ducklakeDeleteFile}
        WHERE table_id IN (${tableIdList}) AND begin_snapshot IN (${snapshotIdList})
        UNION ALL
        SELECT end_snapshot, table_id, true
        FROM ${ducklakeDeleteFile}
        WHERE table_id IN (${tableIdList}) AND end_snapshot IN (${snapshotIdList})
      )
      SELECT snapshot_id, table_id, bool_or(is_delete) AS has_delete
      FROM file_changes
      GROUP BY snapshot_id, table_id
    `)

    for (const row of rows) {
      const key = fileChangeKey(
        String(getBigIntLike(row, "snapshot_id")),
        getBigIntLike(row, "table_id")
      )
      flags.set(key, { hasFileChange: true, hasFileDeleteChange: getBoolean(row, "has_delete") })
    }

    return flags
  }

  private assertNoMetadataConflict(
    snapshotId: string,
    datasetId: string,
    metadata: SixbCommitMetadata | undefined
  ): void {
    if (metadata !== undefined && metadata.datasetId !== datasetId) {
      throw new LakeStorageError(
        `[SixbDuckLake] DuckLake snapshot '${snapshotId}' changed dataset '${datasetId}' but Sixb commit metadata references dataset '${metadata.datasetId}'.`
      )
    }
  }

  async getLatestVersionForDefinition(
    runtime: DuckDbQueryRuntime,
    dataset: DatasetDefinition
  ): Promise<DatasetVersion | null> {
    const tableRef = await resolveDatasetTableRef(this.options, runtime, dataset.id)
    return tableRef ? this.getLatestVersionForTableRef(runtime, tableRef) : null
  }

  async getLatestVersionRefForDefinition(
    runtime: DuckDbQueryRuntime,
    dataset: DatasetDefinition
  ): Promise<DatasetVersionRef | null> {
    const summary = await this.getLatestVersionSummaryForDefinition(runtime, dataset)
    return summary ? { datasetId: summary.datasetId, versionId: summary.versionId } : null
  }

  async getLatestVersionSummaryForDefinition(
    runtime: DuckDbQueryRuntime,
    dataset: DatasetDefinition
  ): Promise<DuckLakeVersionSummary | null> {
    const tableRef = await resolveDatasetTableRef(this.options, runtime, dataset.id)
    if (!tableRef) {
      return null
    }

    const row = await this.getLatestSnapshotRowForTableRef(runtime, tableRef)
    if (!row) {
      return null
    }

    return {
      datasetId: tableRef.datasetId,
      versionId: toVersionId(row.snapshotId),
      ...(row.metadata?.rowCount !== undefined ? { rowCount: row.metadata.rowCount } : {}),
    }
  }

  async getVersionForSnapshot(
    runtime: DuckDbQueryRuntime,
    dataset: DatasetDefinition,
    snapshotId: string
  ): Promise<DatasetVersion | null> {
    assertDuckLakeSnapshotId(snapshotId)

    const tableRef = await resolveDatasetTableRef(this.options, runtime, dataset.id)
    return tableRef ? this.getVersionForTableRef(runtime, tableRef, snapshotId) : null
  }

  async getVersionForTableRef(
    runtime: DuckDbQueryRuntime,
    tableRef: DatasetTableRef,
    snapshotId: string
  ): Promise<DatasetVersion | null> {
    const match = await this.getSnapshotRowForTableRef(runtime, tableRef, snapshotId, {
      includeParent: true,
    })
    return match ? this.snapshotToVersion(runtime, tableRef, match) : null
  }

  async getVersionRefForSnapshot(
    runtime: DuckDbQueryRuntime,
    dataset: DatasetDefinition,
    snapshotId: string
  ): Promise<DatasetVersionRef | null> {
    assertDuckLakeSnapshotId(snapshotId)

    const tableRef = await resolveDatasetTableRef(this.options, runtime, dataset.id)
    if (!tableRef) {
      return null
    }

    const row = await this.getSnapshotRowForTableRef(runtime, tableRef, snapshotId, {
      includeParent: false,
    })
    return row ? { datasetId: tableRef.datasetId, versionId: toVersionId(row.snapshotId) } : null
  }

  async listVersionsForDefinition(
    runtime: DuckDbQueryRuntime,
    dataset: DatasetDefinition,
    limit?: number
  ): Promise<readonly DatasetVersion[]> {
    const tableRef = await resolveDatasetTableRef(this.options, runtime, dataset.id)
    return tableRef ? this.listVersionsForTableRef(runtime, tableRef, limit) : []
  }

  private async listVersionsForTableRef(
    runtime: DuckDbQueryRuntime,
    tableRef: DatasetTableRef,
    limit?: number
  ): Promise<readonly DatasetVersion[]> {
    const limitedRows = await this.getSnapshotRowsForTableRef(runtime, tableRef, limit)
    const versions: DatasetVersion[] = []

    for (const row of limitedRows) {
      versions.push(await this.snapshotToVersion(runtime, tableRef, row))
    }

    return versions
  }

  async getLatestVersionForTableRef(
    runtime: DuckDbQueryRuntime,
    tableRef: DatasetTableRef
  ): Promise<DatasetVersion | null> {
    const [latest] = await this.listVersionsForTableRef(runtime, tableRef, 1)
    return latest ?? null
  }

  private async getLatestSnapshotRowForTableRef(
    runtime: DuckDbQueryRuntime,
    tableRef: DatasetTableRef
  ): Promise<DatasetSnapshotRow | null> {
    const [row] = await this.collectVisibleSnapshotRows(runtime, {
      datasetId: tableRef.datasetId,
      tableId: tableRef.tableId,
      visibleRowLimit: 1,
    })
    return row ?? null
  }

  private async getSnapshotRowForTableRef(
    runtime: DuckDbQueryRuntime,
    tableRef: DatasetTableRef,
    snapshotId: string,
    options: { readonly includeParent: boolean }
  ): Promise<DatasetSnapshotRow | null> {
    assertDuckLakeSnapshotId(snapshotId)

    const [row] = await this.collectVisibleSnapshotRows(runtime, {
      datasetId: tableRef.datasetId,
      tableId: tableRef.tableId,
      exactSnapshotId: snapshotId,
      visibleRowLimit: 1,
    })
    if (!row) {
      return null
    }

    if (
      !options.includeParent ||
      (row.mode !== "append" && row.mode !== "merge" && row.mode !== "schema")
    ) {
      return row
    }

    const [parent] = await this.collectVisibleSnapshotRows(runtime, {
      datasetId: tableRef.datasetId,
      tableId: tableRef.tableId,
      beforeSnapshotId: snapshotId,
      visibleRowLimit: 1,
    })

    return parent ? { ...row, parentSnapshotId: parent.snapshotId } : row
  }

  private async getSnapshotRowsForTableRef(
    runtime: DuckDbQueryRuntime,
    tableRef: DatasetTableRef,
    limit?: number
  ): Promise<readonly DatasetSnapshotRow[]> {
    const visibleLimit = limit === undefined ? undefined : Math.max(0, limit)
    if (visibleLimit === 0) {
      return []
    }

    const rows = await this.collectVisibleSnapshotRows(runtime, {
      datasetId: tableRef.datasetId,
      tableId: tableRef.tableId,
      visibleRowLimit: visibleLimit === undefined ? undefined : visibleLimit + 1,
    })
    const rowsWithParents = this.withParentSnapshotIds(rows)
    return visibleLimit === undefined ? rowsWithParents : rowsWithParents.slice(0, visibleLimit)
  }

  private async collectVisibleSnapshotRows(
    runtime: DuckDbQueryRuntime,
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
    runtime: DuckDbQueryRuntime,
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
        -- Recent DuckLake snapshots to inspect; Sixb visibility is filtered later.
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
        -- Keep metadata-only candidates; Sixb filters them with commit_extra_info.
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
    // their Sixb metadata names this dataset.
    if (!hasDataChange) {
      const metadata = candidate.metadata
      if (!metadata || metadata.datasetId !== datasetId) {
        return null
      }

      return {
        snapshotId: candidate.snapshotId,
        tableId,
        createdAt: candidate.createdAt,
        mode: metadata.mode ?? "schema",
        metadata,
      }
    }

    // A real data-change snapshot belongs to this dataset because DuckLake's
    // change metadata touched this table id. If Sixb metadata is present but
    // points elsewhere, fail loudly rather than hydrating the wrong lineage.
    this.assertNoMetadataConflict(candidate.snapshotId, datasetId, candidate.metadata)

    return {
      snapshotId: candidate.snapshotId,
      tableId,
      createdAt: candidate.createdAt,
      mode: candidate.metadata?.mode ?? (hasDeleteChange ? "snapshot" : "append"),
      ...(candidate.metadata !== undefined ? { metadata: candidate.metadata } : {}),
    }
  }

  private async snapshotToVersion(
    runtime: DuckDbQueryRuntime,
    tableRef: DatasetTableRef,
    row: DatasetSnapshotRow
  ): Promise<DatasetVersion> {
    const schemaAtSnapshot = await this.datasets.getDatasetSchemaAtSnapshot(
      runtime,
      tableRef.datasetId,
      tableRef.tableName,
      tableRef.tableId,
      row.snapshotId
    )

    // DuckLake gives us version id, timestamp, and time travel. Sixb metadata
    // fills in caller intent such as append vs snapshot and producer lineage.
    // Version listing is a metadata path, so it only carries row counts already
    // stored in Sixb commit metadata and never counts historical table contents.

    return {
      datasetId: tableRef.datasetId,
      versionId: toVersionId(row.snapshotId),
      parentVersionId:
        row.parentSnapshotId === undefined ? undefined : toVersionId(row.parentSnapshotId),
      mode: row.mode,
      createdAt: row.createdAt,
      schema: schemaAtSnapshot,
      producer: row.metadata?.producer,
      inputs: row.metadata?.inputs,
      ...(row.metadata?.rowCount !== undefined ? { rowCount: row.metadata.rowCount } : {}),
    }
  }

  private withParentSnapshotIds(
    snapshots: readonly DatasetSnapshotRow[]
  ): readonly DatasetSnapshotRow[] {
    return snapshots.map((snapshot, index) => {
      // Parent ids track versions that reuse the previous dataset state.
      // Snapshot versions replace the rows, so time travel stands on the snapshot id.
      const parentSnapshotId =
        snapshot.mode === "append" || snapshot.mode === "merge" || snapshot.mode === "schema"
          ? snapshots[index + 1]?.snapshotId
          : undefined
      return parentSnapshotId === undefined ? snapshot : { ...snapshot, parentSnapshotId }
    })
  }
}

function assertDuckLakeSnapshotId(snapshotId: string): void {
  if (!/^\d+$/.test(snapshotId)) {
    throw new LakeStorageError(`[SixbDuckLake] Invalid DuckLake snapshot id '${snapshotId}'.`)
  }
}

function fileChangeKey(snapshotId: string, tableId: bigint): string {
  return `${snapshotId}|${tableId}`
}
