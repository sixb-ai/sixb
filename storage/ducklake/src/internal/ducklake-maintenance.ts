import type { DatasetVersionRef } from "@sixb/core/lake-storage"
import { LakeStorageError } from "@sixb/core/lake-storage"
import type {
  DuckLakeMaintenanceOptions,
  DuckLakeMaintenanceReport,
  DuckLakeStorageOptions,
} from "../types"
import { getBigIntLike } from "./duckdb-row"
import type { DuckDbQueryRuntime } from "./duckdb-runtime"
import type { DuckLakeConnectionManager } from "./ducklake-connection-manager"
import type { DuckLakeSnapshotReader } from "./ducklake-snapshot-reader"
import { duckLakeAlias, duckLakeMetadataTableName, quoteSqlString } from "./sql"
import { parseVersionId } from "./versions"

const DEFAULT_RETENTION = "7 days"

interface MaintenanceCounts {
  readonly snapshots: number
  readonly keptSnapshots: number
  readonly oldFiles: number
  readonly orphanedFiles: number
}

/**
 * Expires old snapshots, except those holding a version that is still needed, then reclaims files.
 *
 * DuckLake's own `older_than` would expire the latest version of a dataset idle longer than the
 * retention, leaving its rows without a version to read them through. Maintenance lists the
 * snapshots older than the retention, keeps those holding each dataset's latest version or a
 * protected version, and expires the rest by id. DuckLake then schedules the files only the
 * expired snapshots referenced, as it does with `older_than`.
 */
export class DuckLakeMaintenance {
  constructor(
    private readonly options: DuckLakeStorageOptions,
    private readonly connections: DuckLakeConnectionManager,
    private readonly snapshots: DuckLakeSnapshotReader
  ) {}

  async runMaintenance(
    options: DuckLakeMaintenanceOptions = {}
  ): Promise<DuckLakeMaintenanceReport> {
    this.connections.assertOpen()

    const expireOlderThan = options.expireOlderThan ?? DEFAULT_RETENTION
    const deleteOlderThan = options.deleteOlderThan ?? expireOlderThan
    const dryRun = options.dryRun ?? false
    const protect = (options.protect ?? []).map(protectedSnapshotId)

    if (this.options.readOnly && !dryRun) {
      throw new LakeStorageError(
        "[SixbDuckLake] DuckLake maintenance cannot run in read-only mode."
      )
    }

    return this.connections.withMaintenanceRuntime(async (runtime) => {
      const counts = await this.runMaintenanceProcedures(
        runtime,
        { expireOlderThan, deleteOlderThan },
        protect,
        dryRun
      )

      if (!dryRun) {
        this.connections.markLocalCatalogChanged()
      }

      return {
        dryRun,
        expireOlderThan,
        deleteOlderThan,
        ...counts,
      }
    })
  }

  private async runMaintenanceProcedures(
    runtime: DuckDbQueryRuntime,
    retention: Pick<DuckLakeMaintenanceReport, "expireOlderThan" | "deleteOlderThan">,
    protect: readonly string[],
    dryRun: boolean
  ): Promise<MaintenanceCounts> {
    const aliasSql = quoteSqlString(duckLakeAlias(this.options))
    const oldSnapshotIds = await this.snapshotsOlderThan(runtime, retention.expireOlderThan)
    const needed = new Set([
      ...(await this.snapshots.latestVersionSnapshotIds(runtime)),
      ...protect,
    ])
    const expirable = oldSnapshotIds.filter((snapshotId) => !needed.has(snapshotId))
    const snapshots =
      expirable.length === 0
        ? []
        : await runtime.query(
            maintenanceProcedureSql(
              "ducklake_expire_snapshots",
              aliasSql,
              `versions => [${expirable.join(", ")}]`,
              dryRun
            )
          )
    const oldFiles = await runtime.query(
      maintenanceProcedureSql(
        "ducklake_cleanup_old_files",
        aliasSql,
        `older_than => ${olderThanSql(retention.deleteOlderThan)}`,
        dryRun
      )
    )
    const orphanedFiles = await runtime.query(
      maintenanceProcedureSql(
        "ducklake_delete_orphaned_files",
        aliasSql,
        `older_than => ${olderThanSql(retention.deleteOlderThan)}`,
        dryRun
      )
    )

    return {
      snapshots: snapshots.length,
      keptSnapshots: oldSnapshotIds.length - expirable.length,
      oldFiles: oldFiles.length,
      orphanedFiles: orphanedFiles.length,
    }
  }

  /**
   * Snapshots older than the retention, except the current one, which DuckLake never expires.
   *
   * Not DuckLake's own `older_than` selection: a SQLite catalog stores snapshot times as text with
   * their UTC offset, and with DuckLake 415a9ebd that selection then also returned snapshots
   * written a moment ago outside UTC. Casting the stored text compares instants on every catalog.
   */
  private async snapshotsOlderThan(
    runtime: DuckDbQueryRuntime,
    olderThan: string
  ): Promise<readonly string[]> {
    const ducklakeSnapshot = duckLakeMetadataTableName(this.options, "ducklake_snapshot")
    const rows = await runtime.query(`
      SELECT snapshot_id
      FROM ${ducklakeSnapshot}
      WHERE CAST(snapshot_time AS TIMESTAMPTZ) < ${olderThanSql(olderThan)}
        AND snapshot_id < (
          SELECT snapshot_id FROM ${ducklakeSnapshot} ORDER BY snapshot_id DESC LIMIT 1
        )
      ORDER BY snapshot_id
    `)
    return rows.map((row) => String(getBigIntLike(row, "snapshot_id")))
  }
}

function protectedSnapshotId(ref: DatasetVersionRef): string {
  try {
    return parseVersionId(ref.versionId)
  } catch (error) {
    throw new LakeStorageError(
      `[SixbDuckLake] Cannot protect version '${ref.versionId}' of dataset '${ref.datasetId}' from maintenance: it is not a DuckLake version id.`,
      { cause: error }
    )
  }
}

function olderThanSql(olderThan: string): string {
  return `now() - INTERVAL ${quoteSqlString(olderThan)}`
}

function maintenanceProcedureSql(
  procedure: string,
  aliasSql: string,
  selection: string,
  dryRun: boolean
): string {
  const dryRunSql = dryRun ? "dry_run => true, " : ""
  return `CALL ${procedure}(${aliasSql}, ${dryRunSql}${selection})`
}
