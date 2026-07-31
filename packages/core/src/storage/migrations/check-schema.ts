import type { Storage } from "../types"
import { isMigrationCapableStorage } from "./migrate-storage"

export interface StorageSchemaCheck {
  readonly ok: boolean
  /**
   * Whether anything was actually read. False when the storage exposes no migrators:
   * usable, but on the strength of having no schema rather than of a verified one. A
   * caller that reports "schema current" has to know the difference.
   */
  readonly verified: boolean
  /**
   * Absent only when `ok`. Names the adapter, the state, and what to do about it —
   * a caller can print this without adding anything.
   */
  readonly reason?: string
}

/**
 * Reports whether the configured storage's schema is usable, without touching it.
 *
 * The read-only counterpart of {@link migrateStorage}: every migrator's `status()`,
 * classified once. Storage with no migrators is usable by definition — there is no
 * schema to be behind.
 *
 * Failures are returned, not thrown, because both callers want to report rather than
 * abort: `/ready` answers a probe and `sixb check` prints a panel.
 */
export async function checkStorageSchema(storage: Storage): Promise<StorageSchemaCheck> {
  if (!isMigrationCapableStorage(storage)) return { ok: true, verified: false }

  try {
    // `status()`, never `plan()`. `plan()` calls `ensure()` first, so it runs DDL —
    // `CREATE SCHEMA`/`CREATE TABLE` on Postgres, creating the file on SQLite — and
    // reserves a connection for an advisory lock. This runs on an unauthenticated
    // `/ready`, so it has to be strictly read-only.
    const statuses = await Promise.all(storage.migrators.map((migrator) => migrator.status()))
    const unusable = statuses.filter((status) => status.state !== "current")

    if (unusable.length === 0) return { ok: true, verified: true }

    return {
      ok: false,
      verified: true,
      // Name the adapter and the state. Saying only "could not be verified" left an
      // operator to guess between a missing migration, a schema newer than the build,
      // and no database at all.
      reason: unusable
        .map((status) => `${status.adapterId}: ${status.state} — ${status.reason ?? ""}`)
        .join("; "),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      verified: false,
      reason: `Storage schema could not be verified: ${message}`,
    }
  }
}
