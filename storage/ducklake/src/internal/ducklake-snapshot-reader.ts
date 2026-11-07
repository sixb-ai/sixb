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
  maintainsTable,
  parseCommitMetadata,
  parseTableDataChange,
  parseVersionId,
  type SixbCommitMetadata,
  toVersionId,
} from "./versions"

export interface DatasetSnapshotRow {
  readonly snapshotId: string
  readonly tableId: bigint
  readonly createdAt: Date
  readonly mode: DatasetVersionMode
  readonly rowsChanged: boolean
  readonly lineageChanged: boolean
  readonly parentSnapshotId?: string
  readonly metadata?: SixbCommitMetadata
}

interface DatasetSnapshotCandidateRow {
  readonly snapshotId: string
  readonly createdAt: Date
  readonly changesMade: string
  readonly metadata?: SixbCommitMetadata
}

interface FeedTable {
  readonly datasetId: string
  readonly tableId: bigint
  /** A dataset cannot have a version before its table exists. */
  readonly startSnapshotId: bigint
}

interface SnapshotCandidateQueryInput {
  readonly table: DatasetTableRef
  readonly exactSnapshotId?: string
  readonly beforeSnapshotId?: string
  /** Inclusive lower bound, on top of the table's creation. */
  readonly fromSnapshotId?: string
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

/** A snapshot of the lake's history, as retention reads it. */
export interface DuckLakeHistorySnapshot {
  readonly snapshotId: string
  /** Whether it was committed before the cutoff its page was read with. */
  readonly beforeCutoff: boolean
  /** The datasets it holds a version of: none for a maintenance or catalog-only commit. */
  readonly versionOf: readonly string[]
}

/** A dataset's history between two of its versions, as a change read plans over it. */
export interface DuckLakeChangeRange {
  /** Its versions from the first one to the last one, both included, oldest first. */
  readonly versions: readonly DatasetSnapshotRow[]
  /** DuckLake maintenance commits on the dataset table in between, oldest first. */
  readonly maintenanceSnapshotIds: readonly string[]
  /**
   * Every catalog snapshot in between is still there, retention expired none of them, and each
   * one naming the dataset's tables is a version or a maintenance commit: none altered them
   * outside Sixb, such as a column dropped and added again.
   */
  readonly complete: boolean
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
  readonly rowChanges?: number
  readonly uncomparedReplacements?: number
  readonly validatedPrimaryKeyColumns?: readonly string[]
}

/** One snapshot row from the shared catalog scan, before per-dataset filtering. */
interface CatalogScanSnapshot {
  readonly snapshotId: string
  readonly createdAt: Date
  readonly changesMade: string
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
 * snapshot whose `changes_made` names the dataset table: one that changed its
 * rows, or that altered the table with Sixb commit metadata naming the dataset,
 * as a version that changes no rows does (see the write coordinator's
 * `claimTable`).
 *
 * DuckLake names a table in `changes_made` for every change to its rows, inlined
 * or written to files, so version reads never scan the catalog's file tables.
 * Maintenance commits, which only move rows between files, name the table too and
 * are never versions (see `parseTableDataChange`, `commitMaintenance`).
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

  /** The newest snapshot of the lake. */
  async queryHeadSnapshotId(runtime: DuckDbQueryRuntime): Promise<string> {
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
    const changesBySnapshotId = new Map(
      changeRows.map((row) => [String(getBigIntLike(row, "snapshot_id")), row])
    )
    const tablesByTableId = new Map(tables.map((table) => [table.tableId.toString(), table]))

    for (const snapshot of snapshots) {
      const changes = changesBySnapshotId.get(snapshot.snapshotId)
      if (changes === undefined) {
        continue
      }
      const changesMade = getString(changes, "changes_made")
      const metadata = parseCommitMetadata(changes.commit_extra_info)

      // Only the tables this snapshot names can have a version in it.
      const touched = new Set<FeedTable>()
      for (const change of changesMade.split(",")) {
        const table = tablesByTableId.get(change.split(":")[1] ?? "")
        if (table) touched.add(table)
      }

      for (const table of touched) {
        if (BigInt(snapshot.snapshotId) < table.startSnapshotId) {
          continue
        }
        const row = this.candidateToSnapshotRow(table.datasetId, table.tableId, {
          snapshotId: snapshot.snapshotId,
          createdAt: snapshot.createdAt,
          changesMade,
          ...(metadata !== undefined ? { metadata } : {}),
        })
        if (row && row.mode !== "schema") {
          latest.set(table.datasetId, row)
        }
      }
    }

    return latest
  }

  /** The tables of every dataset the lake holds now. */
  async listCurrentDatasetTables(runtime: DuckDbQueryRuntime): Promise<readonly DatasetTableRef[]> {
    const tables = await runtime.query(`
      SELECT table_name
      FROM ${duckLakeMetadataTableName(this.options, "ducklake_table")}
      WHERE end_snapshot IS NULL
    `)
    const datasetIds = tables.flatMap((table) => {
      const datasetId = decodeDatasetTableName(getString(table, "table_name"))
      return datasetId === null ? [] : [datasetId]
    })

    if (datasetIds.length === 0) {
      return []
    }

    return [...(await this.resolveDatasetTables(runtime, datasetIds)).values()]
  }

  /**
   * Up to `limit` snapshots of the lake's history after `afterSnapshotId`, oldest first. Each one
   * names the datasets it holds a version of, by the same rule as every version read, and says
   * whether it was committed before `cutoff`.
   */
  async readHistoryPage(
    runtime: DuckDbQueryRuntime,
    input: {
      readonly tables: readonly DatasetTableRef[]
      readonly afterSnapshotId?: string
      readonly cutoff: Date
      readonly limit: number
    }
  ): Promise<readonly DuckLakeHistorySnapshot[]> {
    let afterSql = ""
    if (input.afterSnapshotId !== undefined) {
      assertDuckLakeSnapshotId(input.afterSnapshotId)
      afterSql = `WHERE snapshot.snapshot_id > ${input.afterSnapshotId}`
    }

    // Cast, not compared as stored: a SQLite catalog stores snapshot times as text with their UTC
    // offset, which only compares as an instant once cast.
    const rows = await runtime.query(
      buildDuckLakeMetadataQuery(
        this.options,
        (table) => `
          SELECT
            snapshot.snapshot_id,
            snapshot.snapshot_time,
            CAST(snapshot.snapshot_time AS TIMESTAMPTZ)
              < CAST(${quoteSqlString(input.cutoff.toISOString())} AS TIMESTAMPTZ) AS before_cutoff,
            changes.changes_made,
            changes.commit_extra_info
          FROM ${table("ducklake_snapshot")} snapshot
          LEFT JOIN ${table("ducklake_snapshot_changes")} changes
            ON changes.snapshot_id = snapshot.snapshot_id
          ${afterSql}
          ORDER BY snapshot.snapshot_id
          LIMIT ${Math.max(0, Math.trunc(input.limit))}
        `
      )
    )

    const tablesById = new Map<string, DatasetTableRef>()
    for (const table of input.tables) {
      for (const tableId of datasetTableIds(table)) {
        tablesById.set(tableId.toString(), table)
      }
    }

    return rows.map((row) => {
      const candidate: DatasetSnapshotCandidateRow = {
        snapshotId: String(getBigIntLike(row, "snapshot_id")),
        createdAt: getDate(row, "snapshot_time"),
        changesMade: getOptionalString(row, "changes_made") ?? "",
        ...optionalMetadata(row.commit_extra_info),
      }

      // Only the datasets whose tables the snapshot names can have a version in it.
      const touched = new Set<DatasetTableRef>()
      for (const change of candidate.changesMade.split(",")) {
        const table = tablesById.get(change.split(":")[1] ?? "")
        if (table) touched.add(table)
      }

      const versionOf = [...touched]
        .filter((table) => this.candidateToSnapshotRow(table.datasetId, table.tableId, candidate))
        .map((table) => table.datasetId)

      return {
        snapshotId: candidate.snapshotId,
        beforeCutoff: getBoolean(row, "before_cutoff"),
        versionOf,
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

      const tables = [...unresolved.values()]
      const metadata = await this.readCommitMetadata(
        runtime,
        candidates
          .filter((candidate) =>
            tables.some((table) =>
              changesTouchTables(candidate.changesMade, datasetTableIds(table))
            )
          )
          .map((candidate) => candidate.snapshotId)
      )

      for (const candidate of candidates) {
        scanned += 1
        const candidateMetadata = metadata.get(candidate.snapshotId)
        for (const [datasetId, table] of [...unresolved]) {
          const row = this.candidateToSnapshotRow(datasetId, table.tableId, {
            snapshotId: candidate.snapshotId,
            createdAt: candidate.createdAt,
            changesMade: candidate.changesMade,
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
      ...(row.metadata?.rowChanges !== undefined ? { rowChanges: row.metadata.rowChanges } : {}),
      ...(row.metadata?.uncomparedReplacements !== undefined
        ? { uncomparedReplacements: row.metadata.uncomparedReplacements }
        : {}),
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

  /** The snapshot row of one version, with its Sixb commit metadata, and without its parent. */
  async getSnapshotRow(
    runtime: DuckDbQueryRuntime,
    tableRef: DatasetTableRef,
    snapshotId: string
  ): Promise<DatasetSnapshotRow | null> {
    return this.getSnapshotRowForTableRef(runtime, tableRef, snapshotId, { includeParent: false })
  }

  /**
   * The dataset's versions and the table's maintenance commits from one version to a later one,
   * or null when more than `limit` snapshots name the dataset's tables in between. It reads the
   * snapshots of that range only, and counts the catalog's to tell whether any was expired.
   */
  async readChangeRange(
    runtime: DuckDbQueryRuntime,
    tableRef: DatasetTableRef,
    fromSnapshotId: string,
    toSnapshotId: string,
    limit: number
  ): Promise<DuckLakeChangeRange | null> {
    assertDuckLakeSnapshotId(fromSnapshotId)
    assertDuckLakeSnapshotId(toSnapshotId)

    const candidates = await this.querySnapshotCandidates(runtime, {
      table: tableRef,
      fromSnapshotId,
      beforeSnapshotId: (BigInt(toSnapshotId) + 1n).toString(),
      limit: limit + 1,
    })
    if (candidates.length > limit) {
      return null
    }

    const versions: DatasetSnapshotRow[] = []
    const maintenanceSnapshotIds: string[] = []
    let alteredOutsideSixb = false
    for (const candidate of [...candidates].reverse()) {
      if (maintainsTable(candidate.changesMade, tableRef.tableId)) {
        maintenanceSnapshotIds.push(candidate.snapshotId)
        continue
      }

      const version = this.candidateToSnapshotRow(tableRef.datasetId, tableRef.tableId, candidate)
      if (version) {
        versions.push(version)
      } else {
        alteredOutsideSixb = true
      }
    }

    // Snapshot ids are consecutive, so a missing one was expired: it may have held a version.
    const [count] = await runtime.query(`
      SELECT count(*) AS snapshot_count
      FROM ${duckLakeMetadataTableName(this.options, "ducklake_snapshot")}
      WHERE snapshot_id >= ${fromSnapshotId} AND snapshot_id <= ${toSnapshotId}
    `)
    const expected = BigInt(toSnapshotId) - BigInt(fromSnapshotId) + 1n
    const complete =
      !alteredOutsideSixb &&
      count !== undefined &&
      getBigIntLike(count, "snapshot_count") === expected

    return { versions, maintenanceSnapshotIds, complete }
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
   * Hydrates, newest first, the snapshots whose changes name one of the dataset's tables: every
   * snapshot that may hold one of its versions. The text match is a superset;
   * candidateToSnapshotRow decides visibility.
   *
   * The query walks the catalog's snapshot ids downwards, from `beforeSnapshotId` or the head,
   * and stops at the limit or at the table's creation. A lookup therefore reads the snapshots
   * between where it starts and the versions it returns: a few for an active dataset, at most the
   * table's lifetime for one written long ago. It never reads the file tables, whose replaced
   * files stay until cleanup.
   */
  private async querySnapshotCandidates(
    runtime: DuckDbQueryRuntime,
    input: SnapshotCandidateQueryInput
  ): Promise<readonly DatasetSnapshotCandidateRow[]> {
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
    if (input.fromSnapshotId !== undefined) {
      assertDuckLakeSnapshotId(input.fromSnapshotId)
    }

    const rows = await runtime.query(
      buildDuckLakeMetadataQuery(this.options, (table) => {
        // A dataset cannot have a version before its table exists. Use the earliest table record:
        // a rename may create a newer record with the same table id and must not hide older
        // versions.
        const bounds = [
          `changes.snapshot_id >= (
            SELECT min(begin_snapshot)
            FROM ${table("ducklake_table")}
            WHERE table_id = ${input.table.tableId}
          )`,
        ]
        if (input.exactSnapshotId !== undefined) {
          bounds.push(`changes.snapshot_id = ${input.exactSnapshotId}`)
        }
        if (input.beforeSnapshotId !== undefined) {
          bounds.push(`changes.snapshot_id < ${input.beforeSnapshotId}`)
        }
        if (input.fromSnapshotId !== undefined) {
          bounds.push(`changes.snapshot_id >= ${input.fromSnapshotId}`)
        }

        const namesDatasetTable = datasetTableIds(input.table)
          .map(
            (tableId) =>
              `strpos(',' || changes.changes_made || ',', ${quoteSqlString(`:${tableId},`)}) > 0`
          )
          .join(" OR ")

        // Bounds and order follow the snapshot-id primary key, so PostgreSQL reads it backwards
        // and stops at the limit; the text match only filters the rows it passes.
        return `
          SELECT
            changes.snapshot_id,
            snapshot.snapshot_time,
            changes.changes_made,
            changes.commit_extra_info
          FROM ${table("ducklake_snapshot_changes")} changes
          JOIN ${table("ducklake_snapshot")} snapshot
            ON snapshot.snapshot_id = changes.snapshot_id
          WHERE ${bounds.join(" AND ")}
            AND (${namesDatasetTable})
          ORDER BY changes.snapshot_id DESC
          LIMIT ${limit}
        `
      })
    )

    return rows.map((row) => {
      const metadata = parseCommitMetadata(row.commit_extra_info)

      return {
        snapshotId: String(getBigIntLike(row, "snapshot_id")),
        createdAt: getDate(row, "snapshot_time"),
        changesMade: getString(row, "changes_made"),
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
    if (candidate.metadata?.kind === "compaction") {
      return null
    }

    const { hasDataChange, hasDeleteChange } = parseTableDataChange(candidate.changesMade, tableId)

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
        rowsChanged: metadata.rowsChanged ?? true,
        lineageChanged: metadata.lineageChanged ?? true,
        metadata,
      }
    }

    // A real data-change snapshot belongs to this dataset because DuckLake's
    // change metadata touched this table id. If Sixb metadata is present but
    // points elsewhere, fail loudly rather than hydrating the wrong lineage.
    this.assertNoMetadataConflict(candidate.snapshotId, datasetId, candidate.metadata)

    // DuckLake recorded a change to the table's rows, whatever the metadata says.
    return {
      snapshotId: candidate.snapshotId,
      tableId,
      createdAt: candidate.createdAt,
      mode: candidate.metadata?.mode ?? (hasDeleteChange ? "snapshot" : "append"),
      rowsChanged: true,
      lineageChanged: candidate.metadata?.lineageChanged ?? true,
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
    rowsChanged: row.rowsChanged,
    lineageChanged: row.lineageChanged,
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

function optionalMetadata(value: unknown): { readonly metadata?: SixbCommitMetadata } {
  const metadata = parseCommitMetadata(value)
  return metadata === undefined ? {} : { metadata }
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
