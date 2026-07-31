import { describe, expect, test } from "bun:test"
import {
  InMemoryStorage,
  type MigrationCapableStorage,
  type MigrationReport,
  type MigrationStatus,
  type Storage,
  type StorageMigrator,
  type StorageTransactionOptions,
} from "../src"
import { StorageReadiness } from "../src/runtime/storage-readiness"

describe("StorageReadiness", () => {
  test("caches schema validation and keeps probes out of transactions", async () => {
    const probe = deferred<MigrationStatus>()
    let statusCalls = 0
    const storage = new ReadinessStorage([
      migrator(() => {
        statusCalls += 1
        return probe.promise
      }),
    ])
    const readiness = new StorageReadiness(storage)

    readiness.startSchemaValidation()
    expect(await readiness.check()).toEqual({
      status: "unready",
      storage: { reachable: true, schemaValid: false },
      reason: "Storage schema validation is in progress.",
    })

    probe.resolve(currentStatus())
    await waitFor(async () => (await readiness.check()).status === "ready")
    expect(await readiness.check()).toEqual({
      status: "ready",
      storage: { reachable: true, schemaValid: true },
    })
    expect(statusCalls).toBe(1)
    expect(storage.transactionCalls).toBe(0)
  })

  test("reports an unreachable storage without running schema validation", async () => {
    const storage = new UnreachableStorage()
    const readiness = new StorageReadiness(storage)

    expect(await readiness.check()).toEqual({
      status: "unready",
      storage: { reachable: false, schemaValid: false },
      reason: "Storage is unreachable.",
    })
  })

  test("retries transient schema validation failures only after the cooldown", async () => {
    let now = new Date("2026-01-02T03:04:05.000Z")
    let statusCalls = 0
    const storage = new ReadinessStorage([
      migrator(async () => {
        statusCalls += 1
        if (statusCalls === 1) throw new Error("temporary connection failure")
        return currentStatus()
      }),
    ])
    const readiness = new StorageReadiness(storage, {
      schemaRetryDelayMs: 60_000,
      now: () => now,
    })

    expect(await readiness.check()).toMatchObject({ status: "unready" })
    await waitFor(() => Promise.resolve(statusCalls === 1))
    // The thrown cause is carried through instead of being flattened to "could not be
    // verified" — that message left an operator guessing between a missing migration, a
    // schema newer than the build, and an unreachable database.
    expect(await readiness.check()).toMatchObject({
      status: "unready",
      reason: "Storage schema could not be verified: temporary connection failure",
    })
    expect(statusCalls).toBe(1)

    now = new Date(now.getTime() + 59_999)
    await readiness.check()
    expect(statusCalls).toBe(1)

    now = new Date(now.getTime() + 1)
    expect(await readiness.check()).toMatchObject({ status: "unready" })
    await waitFor(async () => (await readiness.check()).status === "ready")
    expect(statusCalls).toBe(2)
  })

  test("becomes ready after pending migrations are applied", async () => {
    let now = new Date("2026-01-02T03:04:05.000Z")
    let migrated = false
    let statusCalls = 0
    const storage = new ReadinessStorage([
      migrator(async () => {
        statusCalls += 1
        return migrated
          ? currentStatus()
          : {
              adapterId: "test",
              latestVersion: 1,
              appliedVersion: 0,
              state: "pending" as const,
              reason: "1 migration(s) are not applied. Run `sixb db migrate`.",
            }
      }),
    ])
    const readiness = new StorageReadiness(storage, {
      schemaRetryDelayMs: 60_000,
      now: () => now,
    })

    // The reason names the adapter and the state, so an operator reading /ready knows
    // whether `sixb db migrate` will fix it.
    await waitFor(async () => {
      const result = await readiness.check()
      return result.reason?.includes("test: pending") === true
    })
    expect(statusCalls).toBe(1)

    migrated = true
    now = new Date(now.getTime() + 60_000)
    await waitFor(async () => (await readiness.check()).status === "ready")
    expect(statusCalls).toBe(2)
  })

  test("never calls migrate(), which would run DDL", async () => {
    // migrate() calls ensure() first: CREATE SCHEMA / CREATE TABLE on Postgres, and
    // creating the database file on SQLite. This runs on an unauthenticated GET /ready and
    // at every api boot, so it has to be strictly read-only. `status()` is the only member
    // of the migrator contract that touches nothing.
    let migrateCalls = 0
    const storage = new ReadinessStorage([
      {
        ...migrator(async () => currentStatus()),
        migrate: async (): Promise<MigrationReport> => {
          migrateCalls += 1
          throw new Error("migrate should not run")
        },
      },
    ])
    const readiness = new StorageReadiness(storage)

    await waitFor(async () => (await readiness.check()).status === "ready")
    expect(migrateCalls).toBe(0)
  })
})

class ReadinessStorage extends InMemoryStorage implements MigrationCapableStorage {
  transactionCalls = 0

  constructor(readonly migrators: readonly StorageMigrator[]) {
    super()
  }

  override async transaction<T>(
    run: (tx: Storage) => Promise<T> | T,
    options?: StorageTransactionOptions
  ): Promise<T> {
    this.transactionCalls += 1
    return super.transaction(run, options)
  }
}

class UnreachableStorage extends InMemoryStorage {
  override async ping(): Promise<void> {
    throw new Error("unreachable")
  }
}

function migrator(status: StorageMigrator["status"]): StorageMigrator {
  return {
    adapterId: "test",
    latestVersion: 1,
    status,
    migrate: async (): Promise<MigrationReport> => ({
      adapterId: "test",
      latestVersion: 1,
      status: "current",
      applied: [],
      skipped: [],
    }),
  }
}

function currentStatus(): MigrationStatus {
  return { adapterId: "test", latestVersion: 1, appliedVersion: 1, state: "current" }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return
    await Bun.sleep(5)
  }
  throw new Error("Timed out waiting for readiness condition.")
}
