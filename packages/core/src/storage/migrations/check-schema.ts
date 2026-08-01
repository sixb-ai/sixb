import type { Storage } from "../types"
import { isMigrationCapableStorage } from "./migrate-storage"

export interface StorageSchemaCheck {
  readonly ok: boolean
  /**
   * Whether anything was read. False when the storage exposes no migrators: usable on the
   * strength of having no schema rather than of a verified one.
   */
  readonly verified: boolean
  /** Absent only when `ok`. Names the adapter, the state, and what to do about it. */
  readonly reason?: string
}

/**
 * Reports whether the configured storage's schema is usable, without touching it.
 *
 * Storage with no migrators is usable by definition. Failures are returned rather than thrown,
 * because both callers report instead of aborting: `/ready` and `sixb check`.
 */
export async function checkStorageSchema(storage: Storage): Promise<StorageSchemaCheck> {
  if (!isMigrationCapableStorage(storage)) return { ok: true, verified: false }

  try {
    // `status()` is the only read-only member of the migrator contract: `migrate()` calls
    // `ensure()` first, so it runs DDL and takes an advisory lock. This serves `/ready`.
    const statuses = await Promise.all(storage.migrators.map((migrator) => migrator.status()))
    const unusable = statuses.filter((status) => status.state !== "current")

    if (unusable.length === 0) return { ok: true, verified: true }

    return {
      ok: false,
      verified: true,
      // Named, because "could not be verified" leaves an operator guessing between a missing
      // migration, a schema newer than the build, and no database at all.
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
