import { SixbError } from "@sixb/core/errors"
import type {
  DuckLakeMaintenanceOptions,
  DuckLakeMaintenanceReport,
  DuckLakeStorageOptions,
} from "../types"
import type { DuckDbQueryRuntime } from "./duckdb-runtime"
import type { DuckLakeConnectionManager } from "./ducklake-connection-manager"
import { duckLakeAlias, quoteSqlString } from "./sql"

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
      throw new SixbError(
        "storage.lake_failed",
        "[SixbDuckLake] DuckLake maintenance cannot run in read-only mode."
      )
    }

    return this.connections.withExclusiveAttached(async (runtime) => {
      const counts = await runMaintenanceProcedures(
        runtime,
        this.options,
        {
          expireOlderThan,
          deleteOlderThan,
        },
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
}

async function runMaintenanceProcedures(
  runtime: DuckDbQueryRuntime,
  options: DuckLakeStorageOptions,
  retention: Pick<DuckLakeMaintenanceReport, "expireOlderThan" | "deleteOlderThan">,
  dryRun: boolean
): Promise<MaintenanceCounts> {
  const aliasSql = quoteSqlString(duckLakeAlias(options))
  const snapshots = await runtime.query(
    maintenanceProcedureSql(
      "ducklake_expire_snapshots",
      aliasSql,
      retention.expireOlderThan,
      dryRun
    )
  )
  const oldFiles = await runtime.query(
    maintenanceProcedureSql(
      "ducklake_cleanup_old_files",
      aliasSql,
      retention.deleteOlderThan,
      dryRun
    )
  )
  const orphanedFiles = await runtime.query(
    maintenanceProcedureSql(
      "ducklake_delete_orphaned_files",
      aliasSql,
      retention.deleteOlderThan,
      dryRun
    )
  )

  return {
    snapshots: snapshots.length,
    oldFiles: oldFiles.length,
    orphanedFiles: orphanedFiles.length,
  }
}

function maintenanceProcedureSql(
  procedure: string,
  aliasSql: string,
  olderThan: string,
  dryRun: boolean
): string {
  const olderThanSql = quoteSqlString(olderThan)
  const dryRunSql = dryRun ? "dry_run => true, " : ""
  return (
    `CALL ${procedure}(${aliasSql}, ${dryRunSql}` +
    `older_than => now() - INTERVAL ${olderThanSql})`
  )
}
