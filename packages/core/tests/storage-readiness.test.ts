import { describe, expect, test } from "bun:test"
import {
  InMemoryStorage,
  type MigrationCapableStorage,
  type MigrationReport,
  type Storage,
  type StorageMigrator,
  type StorageTransactionOptions,
} from "../src"
import { StorageReadiness } from "../src/runtime/storage-readiness"
import type { MigrationPlan } from "../src/storage"

describe("StorageReadiness", () => {
  test("caches schema validation and keeps probes out of transactions", async () => {
    const plan = deferred<MigrationPlan<unknown>>()
    let planCalls = 0
    const storage = new ReadinessStorage([
      {
        adapterId: "test",
        latestVersion: 1,
        plan: () => {
          planCalls += 1
          return plan.promise
        },
        migrate: async (): Promise<MigrationReport> => ({
          adapterId: "test",
          latestVersion: 1,
          status: "current",
          applied: [],
          skipped: [],
        }),
      },
    ])
    const readiness = new StorageReadiness(storage)

    readiness.startSchemaValidation()
    expect(await readiness.check()).toEqual({
      status: "unready",
      storage: { reachable: true, schemaValid: false },
      reason: "Storage schema validation is in progress.",
    })

    plan.resolve({ adapterId: "test", latestVersion: 1, applied: [], pending: [] })
    await waitFor(async () => (await readiness.check()).status === "ready")
    expect(await readiness.check()).toEqual({
      status: "ready",
      storage: { reachable: true, schemaValid: true },
    })
    expect(planCalls).toBe(1)
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
    let planCalls = 0
    const storage = new ReadinessStorage([
      migrator(async () => {
        planCalls += 1
        if (planCalls === 1) throw new Error("temporary connection failure")
        return currentPlan()
      }),
    ])
    const readiness = new StorageReadiness(storage, {
      schemaRetryDelayMs: 60_000,
      now: () => now,
    })

    expect(await readiness.check()).toMatchObject({ status: "unready" })
    await waitFor(() => Promise.resolve(planCalls === 1))
    expect(await readiness.check()).toMatchObject({
      status: "unready",
      reason: "Storage schema could not be verified.",
    })
    expect(planCalls).toBe(1)

    now = new Date(now.getTime() + 59_999)
    await readiness.check()
    expect(planCalls).toBe(1)

    now = new Date(now.getTime() + 1)
    expect(await readiness.check()).toMatchObject({ status: "unready" })
    await waitFor(async () => (await readiness.check()).status === "ready")
    expect(planCalls).toBe(2)
  })

  test("becomes ready after pending migrations are applied", async () => {
    let now = new Date("2026-01-02T03:04:05.000Z")
    let migrated = false
    let planCalls = 0
    const storage = new ReadinessStorage([
      migrator(async () => {
        planCalls += 1
        return migrated
          ? currentPlan()
          : {
              adapterId: "test",
              latestVersion: 1,
              applied: [],
              pending: [{ id: "001", version: 1, name: "initial", up: () => undefined }],
            }
      }),
    ])
    const readiness = new StorageReadiness(storage, {
      schemaRetryDelayMs: 60_000,
      now: () => now,
    })

    await waitFor(async () => {
      const result = await readiness.check()
      return result.reason === "Storage schema has pending migrations."
    })
    expect(planCalls).toBe(1)

    migrated = true
    now = new Date(now.getTime() + 60_000)
    await waitFor(async () => (await readiness.check()).status === "ready")
    expect(planCalls).toBe(2)
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

function migrator(plan: StorageMigrator["plan"]): StorageMigrator {
  return {
    adapterId: "test",
    latestVersion: 1,
    plan,
    migrate: async (): Promise<MigrationReport> => ({
      adapterId: "test",
      latestVersion: 1,
      status: "current",
      applied: [],
      skipped: [],
    }),
  }
}

function currentPlan(): MigrationPlan<unknown> {
  return { adapterId: "test", latestVersion: 1, applied: [], pending: [] }
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
