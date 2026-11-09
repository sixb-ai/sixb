import type {
  DatasetStorageHealth,
  DatasetVersionRef,
  LakeMaintenance,
  LakeRetentionOptions,
  LakeRetentionReport,
} from "@sixb/core/lake-storage"
import { LakeStorageError } from "@sixb/core/lake-storage"
import type { DuckLakeStorageOptions } from "../types"
import { getBigIntLike, getOptionalString } from "./duckdb-row"
import type { DuckDbQueryRuntime } from "./duckdb-runtime"
import type { DuckLakeConnectionManager } from "./ducklake-connection-manager"
import type { DuckLakeDatasetCatalog } from "./ducklake-dataset-catalog"
import { type ExpiryPlan, ExpiryWalk } from "./ducklake-expiry-walk"
import { DuckLakeReadsBusy } from "./ducklake-read-gate"
import type { DuckLakeSnapshotReader } from "./ducklake-snapshot-reader"
import { describeDatasetStorage } from "./ducklake-storage-stats"
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

/**
 * A write in another process puts its files in the data path before it commits: until then no
 * catalog row knows them, and orphan deletion would remove them under the commit, leaving its
 * version unreadable (measured on DuckLake ac7595b0 with a PostgreSQL catalog). File deletion
 * also waits for this provider's reads only, never another process's. Files younger than this
 * are never deleted.
 */
const MIN_DELETE_FILES_AFTER_MS = HOUR_MS

/** Passes in a row in which a step may yield to a concurrent pass before retention fails. */
const MAX_YIELDED_PASSES = 3

type RetentionStep = "snapshot expiry" | "file deletion" | "orphaned file deletion"

interface RetentionYield {
  readonly step: RetentionStep
  readonly error: unknown
}

// Snapshots read per history query.
const HISTORY_PAGE_SIZE = 512

interface Retention {
  readonly keepVersionsForMs: number
  readonly deleteFilesAfterMs: number
  readonly dryRun: boolean
  readonly limit: number
  readonly signal: AbortSignal | undefined
}

/** How one step ended. Neither a lost race nor busy reads is a failure of the step. */
interface RetentionStepResult<T> {
  readonly value: T
  readonly yield?: RetentionYield
  /** Reads kept the step out: its work waits for a later pass, and counts as no yield. */
  readonly readsBusy?: boolean
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
 * expire, and it deletes about `limit` files at most. Only deleting files keeps this provider's
 * reads out, for as long as the deletion itself, and a pass with no file to delete never does. It
 * waits for open reads for a bounded time, then leaves the files to a later pass.
 */
export class DuckLakeMaintenance implements LakeMaintenance {
  /** Passes in a row in which a step yielded, in this provider. */
  private yieldedPasses = 0

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

    // Another pass on the same catalog may run each step at the same time, from another process:
    // the step that loses the race yields, its work done by the other pass or left to the next.
    const expired = await yieldingToConcurrentPass(
      "snapshot expiry",
      () => this.expireSnapshots(plan.expirable, retention.dryRun),
      0
    )
    const files = await yieldingToConcurrentPass(
      "file deletion",
      () => this.deleteScheduledFiles(retention),
      { deleted: 0, hasMore: true }
    )

    // Orphans are files no catalog row knows. Listing the whole data path is the costly part of
    // their search, so it waits for a pass that finds no backlog left.
    const backlog = plan.hasMore || files.value.hasMore || expired.yield !== undefined
    const orphaned: RetentionStepResult<number> = backlog
      ? { value: 0 }
      : await yieldingToConcurrentPass(
          "orphaned file deletion",
          () => this.deleteOrphanedFiles(retention),
          0
        )

    if (!retention.dryRun) {
      this.connections.markLocalCatalogChanged()
    }

    this.countYields([expired.yield, files.yield, orphaned.yield])

    return {
      dryRun: retention.dryRun,
      keepVersionsForMs: retention.keepVersionsForMs,
      deleteFilesAfterMs: retention.deleteFilesAfterMs,
      expiredVersions: expired.value,
      keptVersions: plan.keptVersions,
      deletedFiles: files.value.deleted,
      orphanedFiles: orphaned.value,
      hasMore: backlog || orphaned.yield !== undefined || orphaned.readsBusy === true,
    }
  }

  /**
   * A race lost to a concurrent pass is rare and resolves by the next pass. A step that yields
   * pass after pass is not racing: a file removed outside DuckLake, its catalog row still there,
   * fails its deletion the same way every time. The third pass in a row with a yield throws.
   */
  private countYields(yields: readonly (RetentionYield | undefined)[]): void {
    const last = yields.filter((y) => y !== undefined).at(-1)
    if (last === undefined) {
      this.yieldedPasses = 0
      return
    }

    this.yieldedPasses++
    if (this.yieldedPasses < MAX_YIELDED_PASSES) {
      return
    }

    this.yieldedPasses = 0
    const reason = last.error instanceof Error ? last.error.message : String(last.error)
    throw new LakeStorageError(
      `[SixbDuckLake] Lake retention's ${last.step} failed in ${MAX_YIELDED_PASSES} passes in a row, which no concurrent pass explains: ${reason}`,
      { cause: last.error }
    )
  }

  describeStorage(datasetIds: readonly string[]): Promise<readonly DatasetStorageHealth[]> {
    this.connections.assertOpen()

    return describeDatasetStorage(
      {
        options: this.options,
        connections: this.connections,
        datasets: this.datasets,
        snapshots: this.snapshots,
      },
      datasetIds
    )
  }

  /** Which snapshots to expire, from one walk up the history (see `ExpiryWalk`). */
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

    const walk = new ExpiryWalk({ head, protect, limit: retention.limit })
    let afterSnapshotId: string | undefined

    for (;;) {
      const page = await this.connections.withAttachedRuntime((runtime) =>
        this.snapshots.readHistoryPage(runtime, {
          tables,
          afterSnapshotId,
          cutoff,
          limit: HISTORY_PAGE_SIZE,
        })
      )

      const end = walk.visitPage(page)
      if (end === "limit") return walk.plan(true)
      if (end === "cutoff" || page.length < HISTORY_PAGE_SIZE) return walk.plan(false)

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

    const due = await this.connections.withAttachedRuntime((runtime) =>
      this.scheduledFileTimes(runtime, dueBefore, 1)
    )
    if (due.length === 0) {
      return { deleted: 0, hasMore: false }
    }

    return this.connections.withMaintenanceRuntime(retention.signal, async (runtime) => {
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
   * On a SQLite catalog, DuckLake compares schedule times as text: `2026-11-06 19:32:26-05` as
   * stored, with `2026-11-06T18:00:00+00` as given. The space sorts before the `T`, so any time
   * selects every file stored under that UTC date or an earlier one, a file scheduled a moment ago
   * included, and only whole dates can be told apart.
   *
   * So files go by the date they are stored under, and a date goes once all its files are due. It
   * waits a day at most, whatever keeps being scheduled after it.
   */
  private async deleteScheduledFilesOnSqlite(
    runtime: DuckDbQueryRuntime,
    dueBefore: Date,
    dryRun: boolean
  ): Promise<{ readonly deleted: number; readonly hasMore: boolean }> {
    const [notDue = {}] = await runtime.query(`
      SELECT min(left(schedule_start, 10)) AS first_date
      FROM ${duckLakeMetadataTableName(this.options, "ducklake_files_scheduled_for_deletion")}
      WHERE CAST(schedule_start AS TIMESTAMPTZ) >= ${timestampSql(dueBefore)}
    `)
    const firstDate = getOptionalString(notDue, "first_date")

    const deleted = await runtime.query(
      procedureSql("ducklake_cleanup_old_files", this.aliasSql(), {
        dryRun,
        selection:
          firstDate === undefined
            ? "cleanup_all => true"
            : `older_than => ${timestampSql(dayBefore(firstDate))}`,
      })
    )

    return { deleted: deleted.length, hasMore: false }
  }

  /**
   * Listing the data path can take long and deletes nothing, so it runs beside reads. Only a pass
   * that found orphans keeps them out, which is rare.
   */
  private async deleteOrphanedFiles(retention: Retention): Promise<number> {
    const olderThan = new Date(Date.now() - retention.deleteFilesAfterMs)
    const sql = (dryRun: boolean) =>
      procedureSql("ducklake_delete_orphaned_files", this.aliasSql(), {
        dryRun,
        selection: `older_than => ${timestampSql(olderThan)}`,
      })

    const found = await this.connections.withAttachedRuntime((runtime) => runtime.query(sql(true)))
    if (retention.dryRun || found.length === 0) {
      return found.length
    }

    const deleted = await this.connections.withMaintenanceRuntime(retention.signal, (runtime) =>
      runtime.query(sql(false))
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

/**
 * Runs one retention step, or yields if another retention pass on the same catalog won a race
 * for it. On PostgreSQL, two passes expiring or deleting the same rows at once fail the later
 * transaction ("could not serialize access due to concurrent update") before it changes anything.
 * Two passes deleting the same files on a local data path also race on the files themselves: the
 * later one fails on a file the other removed. A stale plan, run after the other pass committed,
 * finds nothing left and succeeds.
 */
async function yieldingToConcurrentPass<T>(
  step: RetentionStep,
  run: () => Promise<T>,
  yielded: T
): Promise<RetentionStepResult<T>> {
  try {
    return { value: await run() }
  } catch (error) {
    if (error instanceof DuckLakeReadsBusy) {
      return { value: yielded, readsBusy: true }
    }

    if (lostToConcurrentPass(error)) {
      return { value: yielded, yield: { step, error } }
    }

    throw error
  }
}

function lostToConcurrentPass(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  return (
    error.message.includes("could not serialize access due to concurrent") ||
    error.message.includes("Transaction conflict") ||
    (error.message.includes("Could not remove file") &&
      error.message.includes("No such file or directory"))
  )
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

  if (!Number.isFinite(deleteFilesAfterMs) || deleteFilesAfterMs < MIN_DELETE_FILES_AFTER_MS) {
    throw new LakeStorageError(
      `[SixbDuckLake] deleteFilesAfterMs must be at least ${MIN_DELETE_FILES_AFTER_MS} (1 hour), got ${deleteFilesAfterMs}: another process's write puts its files in the data path before it commits, and reads in other processes are not waited for.`
    )
  }

  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new LakeStorageError(
      `[SixbDuckLake] The retention limit must be a positive integer, got ${limit}.`
    )
  }

  return {
    keepVersionsForMs,
    deleteFilesAfterMs,
    dryRun: options.dryRun ?? false,
    limit,
    signal: options.signal,
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

/** The last millisecond before a `YYYY-MM-DD` date starts in UTC. */
function dayBefore(date: string): Date {
  return new Date(Date.parse(`${date}T00:00:00Z`) - 1)
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
