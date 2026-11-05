import type {
  DatasetStorageHealth,
  DatasetVersionRef,
  LakeMaintenance,
  LakeRetentionOptions,
  LakeRetentionReport,
} from "@sixb/core/lake-storage"
import { LakeStorageError } from "@sixb/core/lake-storage"
import type { DuckLakeStorageOptions } from "../types"
import { getBigIntLike } from "./duckdb-row"
import type { DuckDbQueryRuntime } from "./duckdb-runtime"
import type { DuckLakeConnectionManager } from "./ducklake-connection-manager"
import type { DuckLakeDatasetCatalog } from "./ducklake-dataset-catalog"
import { datasetTableIds } from "./ducklake-dataset-table-ref"
import type { DuckLakeSnapshotReader } from "./ducklake-snapshot-reader"
import {
  countRetainedSnapshots,
  type DuckLakeTableStorage,
  partitionWarnings,
  readTableStorage,
  tableRowCount,
} from "./ducklake-storage-stats"
import { isSqliteCatalog } from "./ducklake-version-transaction"
import {
  buildDuckLakeMetadataQuery,
  duckLakeAlias,
  duckLakeMetadataTableName,
  quoteSqlString,
} from "./sql"
import { parseVersionId } from "./versions"

const HOUR_MS = 60 * 60 * 1000
const DEFAULT_RETENTION_MS = 7 * 24 * HOUR_MS
const DEFAULT_LIMIT = 1_000

/**
 * A pipeline step resolves its inputs' latest versions when it starts and reads them by id for as
 * long as it runs. Retention below this would expire versions such reads still use.
 */
const MIN_KEEP_VERSIONS_FOR_MS = HOUR_MS

// Snapshots read per history query.
const HISTORY_PAGE_SIZE = 512

interface Retention {
  readonly keepVersionsForMs: number
  readonly deleteFilesAfterMs: number
  readonly dryRun: boolean
  readonly limit: number
}

interface ExpiryPlan {
  readonly expirable: readonly string[]
  readonly keptVersions: number
  readonly hasMore: boolean
}

/**
 * Retention and storage description for DuckLake.
 *
 * A version expires once a newer version of its dataset has replaced it for `keepVersionsForMs`:
 * its age counts from its successor's commit, not its own. A reader that resolved a dataset's
 * latest version keeps it readable for that long with no state recorded anywhere. Expiry is
 * catalog-only: DuckLake schedules the files only expired snapshots read, and a later pass deletes
 * them once they have been scheduled for `deleteFilesAfterMs`.
 *
 * A pass is bounded: it reads the history oldest first and stops once it has `limit` snapshots to
 * expire, and it deletes about `limit` files at most. Only the file deletion keeps this
 * provider's reads out, for as long as the deletion itself.
 */
export class DuckLakeMaintenance implements LakeMaintenance {
  constructor(
    private readonly options: DuckLakeStorageOptions,
    private readonly connections: DuckLakeConnectionManager,
    private readonly datasets: DuckLakeDatasetCatalog,
    private readonly snapshots: DuckLakeSnapshotReader
  ) {}

  async applyRetention(options: LakeRetentionOptions = {}): Promise<LakeRetentionReport> {
    this.connections.assertOpen()

    const retention = resolveRetention(options)
    const protect = new Set((options.protect ?? []).map(protectedSnapshotId))

    if (this.options.readOnly && !retention.dryRun) {
      throw new LakeStorageError("[SixbDuckLake] DuckLake retention cannot run in read-only mode.")
    }

    const plan = await this.planExpiry(retention, protect)
    const expiredVersions = await this.expireSnapshots(plan.expirable, retention.dryRun)

    const files = await this.deleteScheduledFiles(retention)

    // Orphans are files no catalog row knows. Listing the whole data path is the costly part of
    // their search, so it waits for a pass that finds no backlog left.
    const orphanedFiles =
      plan.hasMore || files.hasMore ? 0 : await this.deleteOrphanedFiles(retention)

    if (!retention.dryRun) {
      this.connections.markLocalCatalogChanged()
    }

    return {
      dryRun: retention.dryRun,
      keepVersionsForMs: retention.keepVersionsForMs,
      deleteFilesAfterMs: retention.deleteFilesAfterMs,
      expiredVersions,
      keptVersions: plan.keptVersions,
      deletedFiles: files.deleted,
      orphanedFiles,
      hasMore: plan.hasMore || files.hasMore,
    }
  }

  async describeStorage(datasetIds: readonly string[]): Promise<readonly DatasetStorageHealth[]> {
    this.connections.assertOpen()

    const requested = new Set(datasetIds)
    if (requested.size === 0) {
      return []
    }

    const described = await this.connections.withAttachedRuntime(async (runtime) => {
      const tables = (await this.snapshots.listCurrentDatasetTables(runtime)).filter((table) =>
        requested.has(table.datasetId)
      )

      return {
        tables: new Map(tables.map((table) => [table.datasetId, table])),
        storage: await readTableStorage(this.options, runtime, tables),
        snapshots: await countRetainedSnapshots(this.options, runtime, tables),
        definitions: await this.datasets.getDatasetsOnRuntime(
          runtime,
          tables.map((table) => table.datasetId)
        ),
      }
    })

    return datasetIds.map((datasetId) => {
      const table = described.tables.get(datasetId)
      if (table === undefined) {
        return unmaterialized(datasetId)
      }

      // A sequenced dataset also stores its source ordering in a companion table.
      const tables = datasetTableIds(table).flatMap((tableId) => {
        const storage = described.storage.get(tableId)
        return storage === undefined ? [] : [storage]
      })
      const sum = (count: (storage: DuckLakeTableStorage) => number) =>
        tables.reduce((total, storage) => total + count(storage), 0)

      const main = described.storage.get(table.tableId)
      const rowCount = main === undefined ? 0 : tableRowCount(main)
      const definition = described.definitions.get(datasetId)

      return {
        datasetId,
        materialized: true,
        rowCount,
        dataFiles: sum((storage) => storage.dataFiles),
        smallDataFiles: sum((storage) => storage.smallDataFiles),
        dataBytes: sum((storage) => storage.dataBytes),
        deleteFiles: sum((storage) => storage.deleteFiles),
        inlinedRows: sum((storage) => storage.inlinedRows),
        retainedSnapshots: described.snapshots.get(datasetId) ?? 0,
        partitionBy: definition?.partitionBy ?? [],
        warnings: partitionWarnings(definition, rowCount),
      }
    })
  }

  /**
   * Which snapshots to expire, from one walk up the history that stops at the retention cutoff,
   * or once `limit` snapshots are expirable.
   *
   * A snapshot holding no version, such as a maintenance commit, expires once it is past the
   * cutoff. A version expires once the next version of its dataset is past the cutoff too: within
   * the walk, every version of a dataset but the last. That last one, a dataset's latest version
   * or one replaced too recently, stays. Each pass starts again from the oldest snapshot left, and
   * only those kept versions stand before the ones it can expire.
   */
  private async planExpiry(
    retention: Retention,
    protect: ReadonlySet<string>
  ): Promise<ExpiryPlan> {
    const cutoff = new Date(Date.now() - retention.keepVersionsForMs)
    const { tables, head } = await this.connections.withAttachedRuntime(async (runtime) => ({
      tables: await this.snapshots.listCurrentDatasetTables(runtime),
      // DuckLake never expires the newest snapshot.
      head: await this.snapshots.queryHeadSnapshotId(runtime),
    }))

    const expirable: string[] = []
    let keptVersions = 0

    // The last version seen of each dataset, and for how many datasets a snapshot still is.
    const lastVersionOf = new Map<string, string>()
    const datasetsStillLast = new Map<string, number>()

    const supersede = (snapshotId: string) => {
      const remaining = (datasetsStillLast.get(snapshotId) ?? 1) - 1
      if (remaining > 0) {
        datasetsStillLast.set(snapshotId, remaining)
        return
      }

      datasetsStillLast.delete(snapshotId)
      if (protect.has(snapshotId)) {
        keptVersions++
      } else {
        expirable.push(snapshotId)
      }
    }

    let afterSnapshotId: string | undefined
    while (true) {
      const page = await this.connections.withAttachedRuntime((runtime) =>
        this.snapshots.readHistoryPage(runtime, {
          tables,
          afterSnapshotId,
          cutoff,
          limit: HISTORY_PAGE_SIZE,
        })
      )

      for (const snapshot of page) {
        if (!snapshot.beforeCutoff) {
          return { expirable, keptVersions, hasMore: false }
        }

        if (snapshot.versionOf.length === 0) {
          if (snapshot.snapshotId !== head) {
            expirable.push(snapshot.snapshotId)
          }
        } else {
          datasetsStillLast.set(snapshot.snapshotId, snapshot.versionOf.length)

          for (const datasetId of snapshot.versionOf) {
            const previous = lastVersionOf.get(datasetId)
            lastVersionOf.set(datasetId, snapshot.snapshotId)
            if (previous !== undefined) {
              supersede(previous)
            }
          }
        }

        if (expirable.length >= retention.limit) {
          return { expirable, keptVersions, hasMore: true }
        }
      }

      if (page.length < HISTORY_PAGE_SIZE) {
        return { expirable, keptVersions, hasMore: false }
      }

      afterSnapshotId = page[page.length - 1]?.snapshotId
    }
  }

  private async expireSnapshots(snapshotIds: readonly string[], dryRun: boolean): Promise<number> {
    if (snapshotIds.length === 0) {
      return 0
    }

    const expired = await this.connections.withExclusiveAttached((runtime) =>
      runtime.query(
        procedureSql("ducklake_expire_snapshots", this.aliasSql(), {
          dryRun,
          selection: `versions => [${snapshotIds.join(", ")}]`,
        })
      )
    )

    return expired.length
  }

  /**
   * Deletes the files scheduled for deletion at least `deleteFilesAfterMs` ago, oldest first and
   * about `limit` at most. DuckLake deletes every file scheduled before the time it is given, so
   * the pass gives it the schedule time of the first file over the limit. Files one commit
   * scheduled share a time, and go together.
   */
  private async deleteScheduledFiles(
    retention: Retention
  ): Promise<{ readonly deleted: number; readonly hasMore: boolean }> {
    const dueBefore = new Date(Date.now() - retention.deleteFilesAfterMs)

    return this.connections.withMaintenanceRuntime(async (runtime) => {
      const scheduled = await this.scheduledFileTimes(runtime, dueBefore, retention.limit + 1)
      const first = scheduled[0]
      if (first === undefined) {
        return { deleted: 0, hasMore: false }
      }

      if (isSqliteCatalog(this.options.catalog)) {
        return this.deleteScheduledFilesOnSqlite(runtime, dueBefore, retention.dryRun)
      }

      const overLimit = scheduled[retention.limit]
      const olderThanSql =
        overLimit === undefined
          ? timestampSql(dueBefore)
          : microsecondsSql(overLimit > first ? overLimit : first + 1n)

      const deleted = await runtime.query(
        procedureSql("ducklake_cleanup_old_files", this.aliasSql(), {
          dryRun: retention.dryRun,
          selection: `older_than => ${olderThanSql}`,
        })
      )

      return { deleted: deleted.length, hasMore: overLimit !== undefined }
    })
  }

  /**
   * On a SQLite catalog, DuckLake compares the schedule times it stores as text with the time it
   * is given unreliably outside UTC: west of UTC, it deleted files scheduled a moment ago. Files
   * there go all at once, and only once every scheduled file is due.
   */
  private async deleteScheduledFilesOnSqlite(
    runtime: DuckDbQueryRuntime,
    dueBefore: Date,
    dryRun: boolean
  ): Promise<{ readonly deleted: number; readonly hasMore: boolean }> {
    const [notDue] = await runtime.query(`
      SELECT count(*) AS files
      FROM ${duckLakeMetadataTableName(this.options, "ducklake_files_scheduled_for_deletion")}
      WHERE CAST(schedule_start AS TIMESTAMPTZ) >= ${timestampSql(dueBefore)}
    `)
    if (notDue === undefined || getBigIntLike(notDue, "files") > 0n) {
      return { deleted: 0, hasMore: false }
    }

    const deleted = await runtime.query(
      procedureSql("ducklake_cleanup_old_files", this.aliasSql(), {
        dryRun,
        selection: "cleanup_all => true",
      })
    )

    return { deleted: deleted.length, hasMore: false }
  }

  private async deleteOrphanedFiles(retention: Retention): Promise<number> {
    const olderThan = new Date(Date.now() - retention.deleteFilesAfterMs)

    const deleted = await this.connections.withMaintenanceRuntime((runtime) =>
      runtime.query(
        procedureSql("ducklake_delete_orphaned_files", this.aliasSql(), {
          dryRun: retention.dryRun,
          selection: `older_than => ${timestampSql(olderThan)}`,
        })
      )
    )

    return deleted.length
  }

  /** When the oldest files due for deletion were scheduled, in microseconds since the epoch. */
  private async scheduledFileTimes(
    runtime: DuckDbQueryRuntime,
    dueBefore: Date,
    limit: number
  ): Promise<readonly bigint[]> {
    const rows = await runtime.query(
      buildDuckLakeMetadataQuery(
        this.options,
        (table) => `
          SELECT CAST(
            EXTRACT(EPOCH FROM CAST(schedule_start AS TIMESTAMPTZ)) * 1000000 AS BIGINT
          ) AS scheduled_at
          FROM ${table("ducklake_files_scheduled_for_deletion")}
          WHERE CAST(schedule_start AS TIMESTAMPTZ) < ${timestampSql(dueBefore)}
          ORDER BY scheduled_at
          LIMIT ${limit}
        `
      )
    )

    return rows.map((row) => getBigIntLike(row, "scheduled_at"))
  }

  private aliasSql(): string {
    return quoteSqlString(duckLakeAlias(this.options))
  }
}

function resolveRetention(options: LakeRetentionOptions): Retention {
  const keepVersionsForMs = options.keepVersionsForMs ?? DEFAULT_RETENTION_MS
  const deleteFilesAfterMs = options.deleteFilesAfterMs ?? DEFAULT_RETENTION_MS
  const limit = options.limit ?? DEFAULT_LIMIT

  if (!Number.isFinite(keepVersionsForMs) || keepVersionsForMs < MIN_KEEP_VERSIONS_FOR_MS) {
    throw new LakeStorageError(
      `[SixbDuckLake] keepVersionsForMs must be at least ${MIN_KEEP_VERSIONS_FOR_MS} (1 hour), got ${keepVersionsForMs}: a pipeline step reads the versions it resolved for as long as it runs.`
    )
  }

  if (!Number.isFinite(deleteFilesAfterMs) || deleteFilesAfterMs < 0) {
    throw new LakeStorageError(
      `[SixbDuckLake] deleteFilesAfterMs must be 0 or more milliseconds, got ${deleteFilesAfterMs}.`
    )
  }

  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new LakeStorageError(
      `[SixbDuckLake] The retention limit must be a positive integer, got ${limit}.`
    )
  }

  return { keepVersionsForMs, deleteFilesAfterMs, dryRun: options.dryRun ?? false, limit }
}

function unmaterialized(datasetId: string): DatasetStorageHealth {
  return {
    datasetId,
    materialized: false,
    rowCount: 0,
    dataFiles: 0,
    smallDataFiles: 0,
    dataBytes: 0,
    deleteFiles: 0,
    inlinedRows: 0,
    retainedSnapshots: 0,
    partitionBy: [],
    warnings: [],
  }
}

function protectedSnapshotId(ref: DatasetVersionRef): string {
  try {
    return parseVersionId(ref.versionId)
  } catch (error) {
    throw new LakeStorageError(
      `[SixbDuckLake] Cannot protect version '${ref.versionId}' of dataset '${ref.datasetId}' from retention: it is not a DuckLake version id.`,
      { cause: error }
    )
  }
}

function timestampSql(date: Date): string {
  return `CAST(${quoteSqlString(date.toISOString())} AS TIMESTAMPTZ)`
}

function microsecondsSql(microseconds: bigint): string {
  return `CAST('1970-01-01 00:00:00+00' AS TIMESTAMPTZ) + to_microseconds(${microseconds})`
}

function procedureSql(
  procedure: string,
  aliasSql: string,
  input: { readonly dryRun: boolean; readonly selection: string }
): string {
  const dryRunSql = input.dryRun ? "dry_run => true, " : ""
  return `CALL ${procedure}(${aliasSql}, ${dryRunSql}${input.selection})`
}
