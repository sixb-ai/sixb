import type { DatasetDefinition, DatasetSchema } from "@sixb/core"
import type {
  DatasetCatalogState,
  DatasetLatestVersionSummary,
  DatasetProducer,
  DatasetVersion,
  DatasetVersionLineage,
  DatasetVersionMode,
  DatasetVersionRef,
  LatestVersionsSince,
  ListLatestVersionsSinceInput,
} from "@sixb/core/lake-storage"
import { LakeStorageError } from "@sixb/core/lake-storage"
import type { DuckLakeStorageOptions } from "../types"
import { getBigIntLike, getBoolean, getDate, getOptionalString, getString } from "./duckdb-row"
import type { DuckDbQueryRuntime } from "./duckdb-runtime"
import type { DuckLakeConnectionManager } from "./ducklake-connection-manager"
import type { DuckLakeDatasetCatalog } from "./ducklake-dataset-catalog"
import {
  type DatasetTableRef,
  datasetTableIds,
  resolveDatasetTableRef,
  resolveDatasetTableRefAtCurrentSnapshot,
} from "./ducklake-dataset-table-ref"
import type { LatestVersionAtSnapshot } from "./ducklake-version-transaction"
import { decodeLineage } from "./lineage-encoding"
import {
  decodeDatasetTableName,
  encodeDatasetSequenceTableName,
  encodeDatasetTableName,
} from "./names"
import { buildDuckLakeMetadataQuery, duckLakeMetadataTableName, quoteSqlString } from "./sql"
import {
  changesTouchTables,
  parseCommitMetadata,
  parseInlineDataChange,
  parseVersionId,
  type SixbCommitMetadata,
  toVersionId,
} from "./versions"

export interface DatasetSnapshotRow {
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

interface FeedTable {
  readonly datasetId: string
  readonly tableId: bigint
  /** A dataset cannot have a version before its table exists. */
  readonly startSnapshotId: bigint
}

interface MissingSnapshotCandidate {
  readonly snapshotId: string
  readonly missing: true
}

interface SnapshotCandidateQueryInput {
  readonly table: DatasetTableRef
  readonly exactSnapshotId?: string
  readonly beforeSnapshotId?: string
  readonly limit: number
}

interface VisibleSnapshotRowsInput {
  readonly table: DatasetTableRef
  readonly exactSnapshotId?: string
  readonly beforeSnapshotId?: string
  readonly visibleRowLimit?: number
}

/** A version reference, with the DuckLake table and snapshot it was resolved through. */
export interface DuckLakeTableVersionRef extends DatasetVersionRef {
  readonly table: DatasetTableRef
  readonly snapshot: DatasetSnapshotRow
}

/** What a commit needs of the version it builds on. */
export interface DuckLakeVersionSummary {
  readonly datasetId: string
  readonly versionId: string
  readonly schema: DatasetSchema
  readonly producer?: DatasetProducer
  readonly inputs?: readonly DatasetVersionRef[]
  readonly lineage?: DatasetVersionLineage
  readonly rowCount?: number
  readonly validatedPrimaryKeyColumns?: readonly string[]
}

/** One snapshot row from the shared catalog scan, before per-dataset filtering. */
interface CatalogScanSnapshot {
  readonly snapshotId: string
  readonly createdAt: Date
  readonly changesMade: string
}

/** Per (snapshot, table) file-change flags merged into the catalog scan. */
interface FileChangeFlags {
  readonly hasFileChange: boolean
  readonly hasFileDeleteChange: boolean
}

const SNAPSHOT_ROW_BATCH_SIZE = 128
// One feed read covers at most this many commits; the next read continues from its cursor.
const FEED_PAGE_SIZE = 512

// A read of the latest version, or of the one before a version, usually finds it among the
// dataset's most recent snapshots. It first reads only a few of them: each carries the commit
// metadata of its version, whose lineage may be large.
const SHORT_READ_BATCH_SIZE = 8

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
    const tablesByDatasetId = await this.resolveDatasetTables(runtime, uniqueIds)
    const latestRowByDatasetId = await this.resolveLatestSnapshotRows(runtime, tablesByDatasetId)

    return uniqueIds.map((datasetId) => {
      if (!tablesByDatasetId.has(datasetId)) {
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

  /**
   * Change feed over DuckLake's snapshot table, which is an append-only commit log: snapshot ids
   * only increase, and a commit becomes visible only after every lower id has (concurrent commits
   * that pick the same id conflict, and the loser retries with the next one). The cursor is the
   * last snapshot id read. Every query is bounded by a snapshot-id range, so an idle read is one
   * indexed query that returns the cursor's own snapshot, whatever the history length.
   */
  async listLatestVersionsSince(
    input: ListLatestVersionsSinceInput
  ): Promise<LatestVersionsSince | null> {
    this.connections.assertOpen()

    return this.connections.withAttachedRuntime(async (runtime) => {
      if (input.cursor === null) {
        return { cursor: await this.queryHeadSnapshotId(runtime), versions: [] }
      }
      if (!/^\d+$/.test(input.cursor)) {
        return null
      }

      const snapshots = await this.querySnapshotsFrom(runtime, input.cursor)
      // The cursor's own snapshot proves the cursor is still a position in this lake's history.
      if (snapshots[0]?.snapshotId !== input.cursor) {
        return null
      }
      const newSnapshots = snapshots.slice(1)
      if (newSnapshots.length === 0) {
        return { cursor: input.cursor, versions: [] }
      }

      const tables = await this.resolveFeedTables(runtime, input.datasetIds)
      const latest = await this.collectFeedPage(runtime, tables, newSnapshots)
      return {
        cursor: newSnapshots[newSnapshots.length - 1]?.snapshotId ?? input.cursor,
        versions: [...latest].map(([datasetId, row]) => this.snapshotRowToSummary(datasetId, row)),
      }
    })
  }

  private async queryHeadSnapshotId(runtime: DuckDbQueryRuntime): Promise<string> {
    const [row] = await runtime.query(
      buildDuckLakeMetadataQuery(
        this.options,
        (table) => `SELECT max(snapshot_id) AS snapshot_id FROM ${table("ducklake_snapshot")}`
      )
    )
    if (row?.snapshot_id === null || row?.snapshot_id === undefined) {
      throw new LakeStorageError("[SixbDuckLake] DuckLake catalog has no snapshots.")
    }
    return String(getBigIntLike(row, "snapshot_id"))
  }

  /** The cursor's snapshot and up to one feed page of snapshots after it, oldest first. */
  private async querySnapshotsFrom(
    runtime: DuckDbQueryRuntime,
    cursor: string
  ): Promise<readonly { readonly snapshotId: string; readonly createdAt: Date }[]> {
    const rows = await runtime.query(
      buildDuckLakeMetadataQuery(
        this.options,
        (table) => `
          SELECT snapshot_id, snapshot_time
          FROM ${table("ducklake_snapshot")}
          WHERE snapshot_id >= ${cursor}
          ORDER BY snapshot_id
          LIMIT ${FEED_PAGE_SIZE + 1}
        `
      )
    )
    return rows.map((row) => ({
      snapshotId: String(getBigIntLike(row, "snapshot_id")),
      createdAt: getDate(row, "snapshot_time"),
    }))
  }

  /** Current dataset tables, with the first snapshot each table id existed in. */
  private async resolveFeedTables(
    runtime: DuckDbQueryRuntime,
    datasetIds: readonly string[] | undefined
  ): Promise<readonly FeedTable[]> {
    const requested = datasetIds === undefined ? null : new Set(datasetIds)
    const rows = await runtime.query(`
      SELECT table_id, table_name, begin_snapshot, end_snapshot
      FROM ${duckLakeMetadataTableName(this.options, "ducklake_table")}
    `)

    const startByTableId = new Map<bigint, bigint>()
    const current: { datasetId: string; tableId: bigint }[] = []
    for (const row of rows) {
      const tableId = getBigIntLike(row, "table_id")
      const begin = getBigIntLike(row, "begin_snapshot")
      const start = startByTableId.get(tableId)
      if (start === undefined || begin < start) {
        startByTableId.set(tableId, begin)
      }
      if (row.end_snapshot !== null && row.end_snapshot !== undefined) {
        continue
      }
      const datasetId = decodeDatasetTableName(getString(row, "table_name"))
      if (datasetId !== null && (requested === null || requested.has(datasetId))) {
        current.push({ datasetId, tableId })
      }
    }

    return current.map((table) => ({
      ...table,
      startSnapshotId: startByTableId.get(table.tableId) ?? 0n,
    }))
  }

  /** Folds a page of snapshots, oldest first, into each dataset's newest data version. */
  private async collectFeedPage(
    runtime: DuckDbQueryRuntime,
    tables: readonly FeedTable[],
    snapshots: readonly { readonly snapshotId: string; readonly createdAt: Date }[]
  ): Promise<Map<string, DatasetSnapshotRow>> {
    const latest = new Map<string, DatasetSnapshotRow>()
    const first = snapshots[0]?.snapshotId
    const last = snapshots[snapshots.length - 1]?.snapshotId
    if (first === undefined || last === undefined || tables.length === 0) {
      return latest
    }

    const changeRows = await runtime.query(
      buildDuckLakeMetadataQuery(
        this.options,
        (table) => `
          SELECT snapshot_id, changes_made, commit_extra_info
          FROM ${table("ducklake_snapshot_changes")}
          WHERE snapshot_id >= ${first} AND snapshot_id <= ${last}
        `
      )
    )
    const fileFlags = await this.queryFileChangeFlags(
      runtime,
      snapshots.map((snapshot) => snapshot.snapshotId),
      tables.map((table) => table.tableId)
    )
    const changesBySnapshotId = new Map(
      changeRows.map((row) => [String(getBigIntLike(row, "snapshot_id")), row])
    )
    const tablesByTableId = new Map(tables.map((table) => [table.tableId.toString(), table]))
    const tablesByDatasetId = new Map(tables.map((table) => [table.datasetId, table]))

    for (const snapshot of snapshots) {
      const changes = changesBySnapshotId.get(snapshot.snapshotId)
      if (changes === undefined) {
        continue
      }
      const changesMade = getString(changes, "changes_made")
      const metadata = parseCommitMetadata(changes.commit_extra_info)

      // Only tables this snapshot names, touches through files, or tags can change visibility.
      const touched = new Set<FeedTable>()
      for (const change of changesMade.split(",")) {
        const table = tablesByTableId.get(change.split(":")[1] ?? "")
        if (table) touched.add(table)
      }
      for (const table of tables) {
        if (fileFlags.has(fileChangeKey(snapshot.snapshotId, table.tableId))) touched.add(table)
      }
      const tagged = metadata === undefined ? undefined : tablesByDatasetId.get(metadata.datasetId)
      if (tagged) touched.add(tagged)

      for (const table of touched) {
        if (BigInt(snapshot.snapshotId) < table.startSnapshotId) {
          continue
        }
        const flags = fileFlags.get(fileChangeKey(snapshot.snapshotId, table.tableId))
        const row = this.candidateToSnapshotRow(table.datasetId, table.tableId, {
          snapshotId: snapshot.snapshotId,
          createdAt: snapshot.createdAt,
          changesMade,
          hasFileChange: flags?.hasFileChange ?? false,
          hasFileDeleteChange: flags?.hasFileDeleteChange ?? false,
          ...(metadata !== undefined ? { metadata } : {}),
        })
        if (row && row.mode !== "schema") {
          latest.set(table.datasetId, row)
        }
      }
    }

    return latest
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

  private async resolveDatasetTables(
    runtime: DuckDbQueryRuntime,
    datasetIds: readonly string[]
  ): Promise<Map<string, DatasetTableRef>> {
    // Encoded table names are a collision-free bijection with dataset ids, so a
    // single `ducklake_table` read maps every requested id to its current tables.
    const datasetIdByTableName = new Map<string, string>()
    const datasetIdBySequenceTableName = new Map<string, string>()
    for (const datasetId of datasetIds) {
      datasetIdByTableName.set(encodeDatasetTableName(datasetId), datasetId)
      datasetIdBySequenceTableName.set(encodeDatasetSequenceTableName(datasetId), datasetId)
    }

    const ducklakeTable = duckLakeMetadataTableName(this.options, "ducklake_table")
    const tableNameList = [...datasetIdByTableName.keys(), ...datasetIdBySequenceTableName.keys()]
      .map((name) => quoteSqlString(name))
      .join(", ")
    const rows = await runtime.query(`
      SELECT table_id, table_name
      FROM ${ducklakeTable}
      WHERE table_name IN (${tableNameList})
        AND end_snapshot IS NULL
    `)

    const tablesByDatasetId = new Map<string, DatasetTableRef>()
    for (const row of rows) {
      const tableName = getString(row, "table_name")
      const datasetId = datasetIdByTableName.get(tableName)
      if (datasetId !== undefined) {
        tablesByDatasetId.set(datasetId, {
          datasetId,
          tableName,
          tableId: getBigIntLike(row, "table_id"),
        })
      }
    }
    for (const row of rows) {
      const datasetId = datasetIdBySequenceTableName.get(getString(row, "table_name"))
      const table = datasetId === undefined ? undefined : tablesByDatasetId.get(datasetId)
      if (datasetId !== undefined && table !== undefined) {
        tablesByDatasetId.set(datasetId, {
          ...table,
          sequenceTableId: getBigIntLike(row, "table_id"),
        })
      }
    }

    return tablesByDatasetId
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
    tablesByDatasetId: ReadonlyMap<string, DatasetTableRef>
  ): Promise<Map<string, DatasetSnapshotRow>> {
    const result = new Map<string, DatasetSnapshotRow>()
    if (tablesByDatasetId.size === 0) {
      return result
    }

    const unresolved = new Map<string, DatasetTableRef>(tablesByDatasetId)
    const tableIds = [...new Set([...tablesByDatasetId.values()].map((table) => table.tableId))]

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
      const tables = [...unresolved.values()]
      const metadata = await this.readCommitMetadata(
        runtime,
        candidates
          .filter((candidate) =>
            tables.some(
              (table) =>
                fileFlags.has(fileChangeKey(candidate.snapshotId, table.tableId)) ||
                changesTouchTables(candidate.changesMade, datasetTableIds(table))
            )
          )
          .map((candidate) => candidate.snapshotId)
      )

      for (const candidate of candidates) {
        scanned += 1
        const candidateMetadata = metadata.get(candidate.snapshotId)
        for (const [datasetId, table] of [...unresolved]) {
          const flags = fileFlags.get(fileChangeKey(candidate.snapshotId, table.tableId))
          const row = this.candidateToSnapshotRow(datasetId, table.tableId, {
            snapshotId: candidate.snapshotId,
            createdAt: candidate.createdAt,
            changesMade: candidate.changesMade,
            hasFileChange: flags?.hasFileChange ?? false,
            hasFileDeleteChange: flags?.hasFileDeleteChange ?? false,
            ...(candidateMetadata !== undefined ? { metadata: candidateMetadata } : {}),
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
        changes.changes_made
      FROM ${ducklakeSnapshot} snapshot
      JOIN ${ducklakeSnapshotChanges} changes ON changes.snapshot_id = snapshot.snapshot_id
      ${whereSql}
      ORDER BY snapshot.snapshot_id DESC
      LIMIT ${Math.max(0, Math.trunc(limit))}
    `)

    return rows.map((row) => ({
      snapshotId: String(getBigIntLike(row, "snapshot_id")),
      createdAt: getDate(row, "snapshot_time"),
      changesMade: getString(row, "changes_made"),
    }))
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
  ): Promise<DuckLakeTableVersionRef | null> {
    const tableRef = await resolveDatasetTableRef(this.options, runtime, dataset.id)
    if (!tableRef) {
      return null
    }

    const row = await this.getLatestSnapshotRowForTableRef(runtime, tableRef)
    return row ? tableVersionRef(tableRef, row) : null
  }

  async getLatestVersionSummaryForDefinition(
    runtime: DuckDbQueryRuntime,
    dataset: DatasetDefinition
  ): Promise<DuckLakeVersionSummary | null> {
    const tableRef = await resolveDatasetTableRef(this.options, runtime, dataset.id)
    return tableRef ? this.getLatestVersionSummaryForTableRef(runtime, tableRef) : null
  }

  /**
   * The latest version a commit builds on, with the lake's snapshot it was read at. Its first
   * read fixes the snapshot of a transaction it runs in (see `beginTransactionOnLatestVersion`).
   */
  async getLatestVersionSummaryAtCurrentSnapshot(
    runtime: DuckDbQueryRuntime,
    dataset: DatasetDefinition
  ): Promise<LatestVersionAtSnapshot<DuckLakeVersionSummary>> {
    const { snapshotId, table } = await resolveDatasetTableRefAtCurrentSnapshot(
      this.options,
      runtime,
      dataset.id
    )
    return {
      snapshotId,
      latestVersion: table ? await this.getLatestVersionSummaryForTableRef(runtime, table) : null,
    }
  }

  private async getLatestVersionSummaryForTableRef(
    runtime: DuckDbQueryRuntime,
    tableRef: DatasetTableRef
  ): Promise<DuckLakeVersionSummary | null> {
    const row = await this.getLatestSnapshotRowForTableRef(runtime, tableRef)
    if (!row) {
      return null
    }

    const [schema] = await this.datasets.getDatasetSchemasAtSnapshots(runtime, [
      { table: tableRef, snapshotId: row.snapshotId },
    ])
    return {
      datasetId: tableRef.datasetId,
      versionId: toVersionId(row.snapshotId),
      schema,
      producer: row.metadata?.producer,
      inputs: row.metadata?.inputs,
      ...storedLineage(tableRef.datasetId, row),
      ...(row.metadata?.rowCount !== undefined ? { rowCount: row.metadata.rowCount } : {}),
      ...(row.metadata?.validatedPrimaryKeyColumns !== undefined
        ? { validatedPrimaryKeyColumns: row.metadata.validatedPrimaryKeyColumns }
        : {}),
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
    return match ? (await this.snapshotsToVersions(runtime, tableRef, [match]))[0] : null
  }

  async getVersionRefForSnapshot(
    runtime: DuckDbQueryRuntime,
    dataset: DatasetDefinition,
    snapshotId: string
  ): Promise<DuckLakeTableVersionRef | null> {
    assertDuckLakeSnapshotId(snapshotId)

    const tableRef = await resolveDatasetTableRef(this.options, runtime, dataset.id)
    if (!tableRef) {
      return null
    }

    const row = await this.getSnapshotRowForTableRef(runtime, tableRef, snapshotId, {
      includeParent: false,
    })
    return row ? tableVersionRef(tableRef, row) : null
  }

  /**
   * The versions resolved refs point to, with their schemas from one catalog read. Refs resolve
   * without their parent, so these versions carry no `parentVersionId`.
   */
  async getVersionsForRefs(
    runtime: DuckDbQueryRuntime,
    refs: readonly DuckLakeTableVersionRef[]
  ): Promise<DatasetVersion[]> {
    const schemas = await this.datasets.getDatasetSchemasAtSnapshots(
      runtime,
      refs.map((ref) => ({ table: ref.table, snapshotId: ref.snapshot.snapshotId }))
    )
    return refs.map((ref, index) => snapshotToVersion(ref.table, ref.snapshot, schemas[index]))
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
    return this.snapshotsToVersions(runtime, tableRef, limitedRows)
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
      table: tableRef,
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
      table: tableRef,
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
      table: tableRef,
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
      table: tableRef,
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
    let shortRead =
      input.exactSnapshotId !== undefined ||
      (input.visibleRowLimit !== undefined && input.visibleRowLimit <= 2)

    while (input.visibleRowLimit === undefined || snapshots.length < input.visibleRowLimit) {
      const batchSize = shortRead ? SHORT_READ_BATCH_SIZE : SNAPSHOT_ROW_BATCH_SIZE
      const candidates = await this.querySnapshotCandidates(runtime, {
        table: input.table,
        exactSnapshotId: input.exactSnapshotId,
        beforeSnapshotId,
        limit: input.exactSnapshotId === undefined ? batchSize : 1,
      })
      shortRead = false
      if (candidates.length === 0) {
        break
      }

      for (const candidate of candidates) {
        if ("missing" in candidate) {
          continue
        }
        const snapshot = this.candidateToSnapshotRow(
          input.table.datasetId,
          input.table.tableId,
          candidate
        )
        if (snapshot) {
          snapshots.push(snapshot)
        }

        if (input.visibleRowLimit !== undefined && snapshots.length >= input.visibleRowLimit) {
          break
        }
      }

      if (input.exactSnapshotId !== undefined || candidates.length < batchSize) {
        break
      }

      beforeSnapshotId = candidates[candidates.length - 1]?.snapshotId
    }

    return snapshots
  }

  /**
   * Hydrates, newest first, the snapshots that may hold a version of one dataset table: those
   * that added or removed its data or delete files, that DuckLake recorded as changing it inline,
   * or whose Sixb commit metadata names the dataset. The text matches are a superset;
   * candidateToSnapshotRow decides visibility. Only this table's snapshots are read, so the cost
   * follows the dataset's own history rather than every commit in the catalog.
   *
   * Returns one row per candidate id, including ids whose snapshot no longer exists, so the caller
   * can tell a short batch from the end of the history.
   */
  private async querySnapshotCandidates(
    runtime: DuckDbQueryRuntime,
    input: SnapshotCandidateQueryInput
  ): Promise<readonly (DatasetSnapshotCandidateRow | MissingSnapshotCandidate)[]> {
    const tableId = input.table.tableId.toString()
    const limit = Math.max(0, Math.trunc(input.limit))
    if (limit === 0) {
      return []
    }
    if (input.exactSnapshotId !== undefined) {
      assertDuckLakeSnapshotId(input.exactSnapshotId)
    }
    if (input.beforeSnapshotId !== undefined) {
      assertDuckLakeSnapshotId(input.beforeSnapshotId)
    }

    const rows = await runtime.query(
      buildDuckLakeMetadataQuery(this.options, (table) => {
        // A dataset cannot have a version before its table exists. Use the earliest table record:
        // a rename may create a newer record with the same table id and must not hide older
        // versions.
        const tableStart = `(SELECT min(begin_snapshot) FROM ${table("ducklake_table")} WHERE table_id = ${tableId})`
        const changesTouchDataset = (changesMade: string) =>
          datasetTableIds(input.table)
            .map((id) => `strpos(',' || ${changesMade} || ',', ${quoteSqlString(`:${id},`)}) > 0`)
            .join(" OR ")
        const candidateIds =
          input.exactSnapshotId !== undefined
            ? `SELECT CAST(${input.exactSnapshotId} AS BIGINT) AS snapshot_id
               WHERE ${input.exactSnapshotId} >= ${tableStart}`
            : `SELECT DISTINCT snapshot_id
               FROM (
                 SELECT begin_snapshot AS snapshot_id
                 FROM ${table("ducklake_data_file")} WHERE table_id = ${tableId}
                 UNION ALL
                 SELECT end_snapshot
                 FROM ${table("ducklake_data_file")}
                 WHERE table_id = ${tableId} AND end_snapshot IS NOT NULL
                 UNION ALL
                 SELECT begin_snapshot
                 FROM ${table("ducklake_delete_file")} WHERE table_id = ${tableId}
                 UNION ALL
                 SELECT end_snapshot
                 FROM ${table("ducklake_delete_file")}
                 WHERE table_id = ${tableId} AND end_snapshot IS NOT NULL
                 UNION ALL
                 SELECT snapshot_id
                 FROM ${table("ducklake_snapshot_changes")}
                 WHERE ${changesTouchDataset("changes_made")}
                   OR strpos(
                     commit_extra_info,
                     ${quoteSqlString(`"datasetId":${JSON.stringify(input.table.datasetId)}`)}
                   ) > 0
               ) touched
               WHERE snapshot_id >= ${tableStart}
                 ${input.beforeSnapshotId === undefined ? "" : `AND snapshot_id < ${input.beforeSnapshotId}`}
               ORDER BY snapshot_id DESC
               LIMIT ${limit}`

        return `
          WITH candidate_ids AS (
            ${candidateIds}
          ),
          candidate_snapshots AS (
            SELECT
              snapshot.snapshot_id,
              snapshot.snapshot_time,
              changes.changes_made,
              changes.commit_extra_info
            FROM ${table("ducklake_snapshot")} snapshot
            JOIN ${table("ducklake_snapshot_changes")} changes
              ON changes.snapshot_id = snapshot.snapshot_id
            WHERE snapshot.snapshot_id IN (SELECT snapshot_id FROM candidate_ids)
          ),
          file_changes AS (
            -- File metadata tells whether this table changed in each candidate snapshot.
            SELECT begin_snapshot AS snapshot_id, false AS is_delete_change
            FROM ${table("ducklake_data_file")}
            WHERE table_id = ${tableId}
              AND begin_snapshot IN (SELECT snapshot_id FROM candidate_ids)
            UNION ALL
            SELECT end_snapshot AS snapshot_id, true AS is_delete_change
            FROM ${table("ducklake_data_file")}
            WHERE table_id = ${tableId}
              AND end_snapshot IN (SELECT snapshot_id FROM candidate_ids)
            UNION ALL
            SELECT begin_snapshot AS snapshot_id, true AS is_delete_change
            FROM ${table("ducklake_delete_file")}
            WHERE table_id = ${tableId}
              AND begin_snapshot IN (SELECT snapshot_id FROM candidate_ids)
            UNION ALL
            SELECT end_snapshot AS snapshot_id, true AS is_delete_change
            FROM ${table("ducklake_delete_file")}
            WHERE table_id = ${tableId}
              AND end_snapshot IN (SELECT snapshot_id FROM candidate_ids)
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
            candidate_ids.snapshot_id,
            candidate.snapshot_time,
            candidate.changes_made,
            -- Only a snapshot that changed one of the dataset's tables can be its version. Others,
            -- such as a later version that names the dataset among its inputs, keep their
            -- metadata, which carries that version's possibly large lineage, in the catalog.
            CASE
              WHEN coalesce(file_changes.has_file_change, false)
                OR ${changesTouchDataset("candidate.changes_made")}
              THEN candidate.commit_extra_info
            END AS commit_extra_info,
            coalesce(file_changes.has_file_change, false) AS has_file_change,
            coalesce(file_changes.has_file_delete_change, false) AS has_file_delete_change
          FROM candidate_ids
          LEFT JOIN candidate_snapshots candidate
            ON candidate.snapshot_id = candidate_ids.snapshot_id
          LEFT JOIN file_changes_by_snapshot file_changes
            ON file_changes.snapshot_id = candidate_ids.snapshot_id
          ORDER BY candidate_ids.snapshot_id DESC
        `
      })
    )

    return rows.map((row) => {
      const snapshotId = String(getBigIntLike(row, "snapshot_id"))
      // Expired snapshots keep their file records; they are no longer versions.
      if (row.snapshot_time === null || row.snapshot_time === undefined) {
        return { snapshotId, missing: true } as const
      }
      const metadata = parseCommitMetadata(row.commit_extra_info)
      return {
        snapshotId,
        createdAt: getDate(row, "snapshot_time"),
        changesMade: getString(row, "changes_made"),
        hasFileChange: getBoolean(row, "has_file_change"),
        hasFileDeleteChange: getBoolean(row, "has_file_delete_change"),
        ...(metadata !== undefined ? { metadata } : {}),
      }
    })
  }

  /**
   * Sixb commit metadata of the snapshots that changed a scanned dataset. Each one carries the
   * lineage of its version, which can be large: scans read it only for the snapshots they keep,
   * never for the other datasets' snapshots they page past.
   */
  private async readCommitMetadata(
    runtime: DuckDbQueryRuntime,
    snapshotIds: readonly string[]
  ): Promise<Map<string, SixbCommitMetadata>> {
    const metadata = new Map<string, SixbCommitMetadata>()
    if (snapshotIds.length === 0) {
      return metadata
    }

    for (const snapshotId of snapshotIds) {
      assertDuckLakeSnapshotId(snapshotId)
    }

    const ducklakeSnapshotChanges = duckLakeMetadataTableName(
      this.options,
      "ducklake_snapshot_changes"
    )
    const rows = await runtime.query(`
      SELECT snapshot_id, commit_extra_info
      FROM ${ducklakeSnapshotChanges}
      WHERE snapshot_id IN (${snapshotIds.join(", ")})
    `)
    for (const row of rows) {
      const parsed = parseCommitMetadata(getOptionalString(row, "commit_extra_info"))
      if (parsed !== undefined) {
        metadata.set(String(getBigIntLike(row, "snapshot_id")), parsed)
      }
    }

    return metadata
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

  /** One catalog read for the schemas of every listed version, not one per version. */
  private async snapshotsToVersions(
    runtime: DuckDbQueryRuntime,
    tableRef: DatasetTableRef,
    rows: readonly DatasetSnapshotRow[]
  ): Promise<DatasetVersion[]> {
    const schemas = await this.datasets.getDatasetSchemasAtSnapshots(
      runtime,
      rows.map((row) => ({ table: tableRef, snapshotId: row.snapshotId }))
    )
    return rows.map((row, index) => snapshotToVersion(tableRef, row, schemas[index]))
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

function snapshotToVersion(
  tableRef: DatasetTableRef,
  row: DatasetSnapshotRow,
  schema: DatasetVersion["schema"]
): DatasetVersion {
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
    schema,
    producer: row.metadata?.producer,
    inputs: row.metadata?.inputs,
    ...storedLineage(tableRef.datasetId, row),
    ...(row.metadata?.rowCount !== undefined ? { rowCount: row.metadata.rowCount } : {}),
  }
}

/**
 * A data snapshot without Sixb metadata was written outside Sixb, by any DuckLake client. It may
 * keep rows of its parent whatever change it made, and nothing says where its own rows come from:
 * its lineage is unknown.
 */
function storedLineage(
  datasetId: string,
  row: DatasetSnapshotRow
): Pick<DatasetVersion, "lineage"> {
  const metadata = row.metadata
  if (metadata === undefined) {
    return {
      lineage: {
        unknown: `version '${toVersionId(row.snapshotId)}' of '${datasetId}' was written outside Sixb`,
      },
    }
  }

  return metadata.lineage === undefined
    ? {}
    : { lineage: decodeLineage(metadata.datasetId, metadata.lineage) }
}

function tableVersionRef(
  table: DatasetTableRef,
  snapshot: DatasetSnapshotRow
): DuckLakeTableVersionRef {
  return {
    datasetId: table.datasetId,
    versionId: toVersionId(snapshot.snapshotId),
    table,
    snapshot,
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
