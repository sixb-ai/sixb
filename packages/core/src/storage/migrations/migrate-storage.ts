import type { Storage } from "../types"
import type { MigrationCapableStorage, MigrationReport, StorageMigrationResult } from "./types"

export function isMigrationCapableStorage(storage: Storage): storage is MigrationCapableStorage {
  return Array.isArray((storage as { migrators?: unknown }).migrators)
}

/** Runs storage adapter migrators when the configured storage exposes them. */
export async function migrateStorage(storage: Storage): Promise<StorageMigrationResult> {
  if (!isMigrationCapableStorage(storage) || storage.migrators.length === 0) {
    return { status: "skipped", reports: [] }
  }

  const reports: MigrationReport[] = []

  for (const migrator of storage.migrators) {
    reports.push(await migrator.migrate())
  }

  return {
    status: reports.some((report) => report.status === "migrated") ? "migrated" : "current",
    reports,
  }
}
