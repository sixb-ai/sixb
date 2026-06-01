import { LakeStorageError } from "@sixb/core"
import type {
  DuckLakeMaintenanceOptions,
  DuckLakeMaintenanceReport,
  DuckLakeStorageOptions,
} from "../types"
import type { DuckDbQueryRuntime } from "./duckdb-runtime"
import type { DuckLakeConnectionManager } from "./ducklake-connection-manager"
import { duckLakeAlias, quoteIdentifier, quoteSqlString } from "./sql"

const DEFAULT_RETENTION = "7 days"

interface MaintenanceCounts {
  readonly snapshots: number
  readonly oldFiles: number
  readonly orphanedFiles: number
}

export class DuckLakeMaintenance {
  constructor(
    private readonly options: DuckLakeStorageOptions,
    private readonly connections: DuckLakeConnectionManager
  ) {}

  async runMaintenance(
    options: DuckLakeMaintenanceOptions = {}
  ): Promise<DuckLakeMaintenanceReport> {
    this.connections.assertOpen()

    const expireOlderThan = options.expireOlderThan ?? DEFAULT_RETENTION
    const deleteOlderThan = options.deleteOlderThan ?? expireOlderThan
    const dryRun = options.dryRun ?? false

    if (this.options.readOnly && !dryRun) {
      throw new LakeStorageError(
        "[SixbDuckLake] DuckLake maintenance cannot run in read-only mode."
      )
    }

    return this.connections.withExclusiveAttached(async (runtime) => {
      const counts = await collectDryRunCounts(runtime, this.options, {
        expireOlderThan,
        deleteOlderThan,
      })

      if (!dryRun) {
        await setMaintenanceOptions(runtime, this.options, {
          expireOlderThan,
          deleteOlderThan,
        })
        await runtime.run("CHECKPOINT")
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
}

async function collectDryRunCounts(
  runtime: DuckDbQueryRuntime,
  options: DuckLakeStorageOptions,
  retention: Pick<DuckLakeMaintenanceReport, "expireOlderThan" | "deleteOlderThan">
): Promise<MaintenanceCounts> {
  const aliasSql = quoteSqlString(duckLakeAlias(options))
  const snapshots = await runtime.query(
    maintenanceDryRunSql("ducklake_expire_snapshots", aliasSql, retention.expireOlderThan)
  )
  const oldFiles = await runtime.query(
    maintenanceDryRunSql("ducklake_cleanup_old_files", aliasSql, retention.deleteOlderThan)
  )
  const orphanedFiles = await runtime.query(
    maintenanceDryRunSql("ducklake_delete_orphaned_files", aliasSql, retention.deleteOlderThan)
  )

  return {
    snapshots: snapshots.length,
    oldFiles: oldFiles.length,
    orphanedFiles: orphanedFiles.length,
  }
}

function maintenanceDryRunSql(procedure: string, aliasSql: string, olderThan: string): string {
  const olderThanSql = quoteSqlString(olderThan)
  return (
    `CALL ${procedure}(${aliasSql}, dry_run => true, ` +
    `older_than => now() - INTERVAL ${olderThanSql})`
  )
}

async function setMaintenanceOptions(
  runtime: DuckDbQueryRuntime,
  options: DuckLakeStorageOptions,
  retention: Pick<DuckLakeMaintenanceReport, "expireOlderThan" | "deleteOlderThan">
): Promise<void> {
  const lake = quoteIdentifier(duckLakeAlias(options))

  await runtime.run(
    `CALL ${lake}.set_option('expire_older_than', ${quoteSqlString(retention.expireOlderThan)})`
  )
  await runtime.run(
    `CALL ${lake}.set_option('delete_older_than', ${quoteSqlString(retention.deleteOlderThan)})`
  )
}
