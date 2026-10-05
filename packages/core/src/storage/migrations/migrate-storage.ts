import {
  isQueryPreparationCapableStorage,
  type ObjectQueryPreparationResult,
  prepareObjectQueries,
} from "../objects/query-preparation"
import type { Storage } from "../types"
import type {
  MigrationCapableStorage,
  MigrationReport,
  StorageMigrationOptions,
  StorageMigrationResult,
} from "./types"

export function isMigrationCapableStorage(storage: Storage): storage is MigrationCapableStorage {
  return Array.isArray((storage as { migrators?: unknown }).migrators)
}

/** Run schema migrations, then prepare query indexes when the provider supports it. */
export async function migrateStorage(
  storage: Storage,
  options?: StorageMigrationOptions
): Promise<StorageMigrationResult> {
  const reports: MigrationReport[] = []
  if (isMigrationCapableStorage(storage)) {
    for (const migrator of storage.migrators) {
      reports.push(await migrator.migrate())
    }
  }

  let queries: ObjectQueryPreparationResult | undefined
  if (options && isQueryPreparationCapableStorage(storage)) {
    queries = await prepareObjectQueries({ ...options, storage })
    for (const warning of queries.warnings) {
      console.warn(`[Sixb] ${warning}`)
    }
  }

  let status: StorageMigrationResult["status"] = "skipped"
  if (reports.length > 0 || queries) {
    status = "current"
  }
  if (reports.some((report) => report.status === "migrated") || queries?.status === "prepared") {
    status = "migrated"
  }

  if (queries) return { status, reports, queries }
  return { status, reports }
}
