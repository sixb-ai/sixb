import { describe, expect, test } from "bun:test"
import { InMemoryStorage, type MigrationReport, type StorageMigrator } from "@sixb/core"
import { errorRemediation } from "../src/lib/errors"
import type { LoadedSixb } from "../src/lib/loadSixb"
import { migrateStorageForRole } from "../src/lib/storage-migration"

describe("migrateStorageForRole", () => {
  test("names every applied step instead of reporting a bare status", async () => {
    const sixb = runtimeWithMigrators([
      migrator("Sqlite", ["0001_objects", "0002_links"]),
      migrator("Lake", ["0001_manifests"]),
    ])

    const migration = await migrateStorageForRole(sixb, { role: "api", env: {} })

    expect(migration.outcome).toBe("migrated")
    // Which steps ran is the only part an operator can check against a release note.
    // "migrated" alone leaves them unable to tell a full run from a partial one.
    expect(migration.applied).toEqual(["0001_objects", "0002_links", "0001_manifests"])
    expect(migration.summary).toBe("migrated: 0001_objects, 0002_links, 0001_manifests")
  })

  test("reports an up-to-date schema without claiming to have changed it", async () => {
    const sixb = runtimeWithMigrators([migrator("Sqlite", [])])

    const migration = await migrateStorageForRole(sixb, { role: "worker", env: {} })

    expect(migration).toEqual({ outcome: "current", applied: [], summary: "schema up to date" })
  })

  test("stays quiet when the configured storage has no migrators", async () => {
    const sixb = runtimeWithMigrators([])

    const migration = await migrateStorageForRole(sixb, { role: "rules", env: {} })

    // An in-memory runtime has no schema to bring up to date, so a "Storage" panel here
    // would be a line that means nothing.
    expect(migration).toEqual({ outcome: "skipped", applied: [], summary: null })
  })

  test("says which opt-out it honoured rather than skipping silently", async () => {
    const sixb = runtimeWithMigrators([migrator("Sqlite", ["0001_objects"])])

    const byFlag = await migrateStorageForRole(sixb, {
      role: "scheduler",
      noMigrate: true,
      env: {},
    })
    const byEnv = await migrateStorageForRole(sixb, {
      role: "scheduler",
      env: { SIXB_SKIP_MIGRATION: "1" },
    })

    for (const migration of [byFlag, byEnv]) {
      expect(migration.outcome).toBe("disabled")
      expect(migration.applied).toEqual([])
      expect(migration.summary).toContain("sixb db migrate")
    }
    // The two opt-outs are distinguishable: an operator debugging a stale schema needs to
    // know whether to look at the deployment command or at the environment.
    expect(byFlag.summary).toContain("--no-migrate")
    expect(byEnv.summary).toContain("SIXB_SKIP_MIGRATION=1")
  })

  test("does not migrate, or announce a migration, when opted out", async () => {
    let migrateCalls = 0
    let started = false
    const sixb = runtimeWithMigrators([
      {
        ...migrator("Sqlite", []),
        migrate: async (): Promise<MigrationReport> => {
          migrateCalls += 1
          return report("Sqlite", [])
        },
      },
    ])

    await migrateStorageForRole(sixb, {
      role: "orchestrator",
      noMigrate: true,
      env: {},
      onStart: () => {
        started = true
      },
    })

    expect(migrateCalls).toBe(0)
    // `onStart` moves the startup spinner to "Migrating storage". Firing it on the opt-out
    // path would show operators a migration that never runs.
    expect(started).toBe(false)
  })

  test("an unset SIXB_SKIP_MIGRATION does not opt out", async () => {
    const sixb = runtimeWithMigrators([migrator("Sqlite", ["0001_objects"])])

    const migration = await migrateStorageForRole(sixb, {
      role: "api",
      // Only the exact value `1` opts out: an empty or leftover variable must not silently
      // disable migrations for a whole deployment.
      env: { SIXB_SKIP_MIGRATION: "" },
    })

    expect(migration.outcome).toBe("migrated")
  })

  test("explains a locked database instead of surfacing SQLITE_BUSY", async () => {
    const sixb = runtimeWithMigrators([
      {
        ...migrator("Sqlite", []),
        migrate: async (): Promise<MigrationReport> => {
          throw new Error("SQLITE_BUSY: database is locked")
        },
      },
    ])

    // SQLite has no cross-process migration lock, so this is the one concurrency case the
    // adapters cannot serialize. The raw driver error says nothing about the cause or the
    // fix, and it is exactly what two roles starting together produce.
    const failure = await captureError(() =>
      migrateStorageForRole(sixb, { role: "worker", env: {} })
    )

    expect(failure.message).toContain("`sixb worker`")
    expect(failure.message).toContain("no cross-process migration lock")
    // The driver's own words are kept: they are what an operator will search for.
    expect(failure.message).toContain("SQLITE_BUSY")
    expect(failure.cause).toBeInstanceOf(Error)
    // What to do is a remediation, not part of the diagnosis.
    expect(errorRemediation(failure)).toContain("--no-migrate")
  })

  test("passes an unrelated migration failure through untouched", async () => {
    const sixb = runtimeWithMigrators([
      {
        ...migrator("Sqlite", []),
        migrate: async (): Promise<MigrationReport> => {
          throw new Error("[Sqlite] 0002_links checksum changed since it was applied.")
        },
      },
    ])

    // A checksum mismatch already says what happened and what to do. Wrapping it would
    // bury the useful message under a story about locks.
    await expect(migrateStorageForRole(sixb, { role: "api", env: {} })).rejects.toThrow(
      "[Sqlite] 0002_links checksum changed since it was applied."
    )
  })
})

async function captureError(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run()
  } catch (error) {
    if (error instanceof Error) return error
    throw error
  }
  throw new Error("Expected the call to reject.")
}

function runtimeWithMigrators(migrators: readonly StorageMigrator[]): LoadedSixb {
  const storage = Object.assign(new InMemoryStorage(), { migrators })
  return { storage } as unknown as LoadedSixb
}

function report(adapterId: string, applied: readonly string[]): MigrationReport {
  return {
    adapterId,
    latestVersion: applied.length,
    status: applied.length > 0 ? "migrated" : "current",
    applied,
    skipped: [],
  }
}

function migrator(adapterId: string, applied: readonly string[]): StorageMigrator {
  return {
    adapterId,
    latestVersion: applied.length,
    status: async () => ({
      adapterId,
      latestVersion: applied.length,
      appliedVersion: applied.length,
      state: "current",
    }),
    plan: async () => {
      throw new Error("plan should not run")
    },
    migrate: async () => report(adapterId, applied),
  }
}
