import { describe, expect, test } from "bun:test"
import {
  InMemoryBroker,
  InMemoryQueues,
  InMemoryStorage,
  type MigrationStatus,
  type StorageMigrator,
} from "@sixb/core"
import { checkRuntimeHealth } from "../src/lib/health"
import type { LoadedSixb } from "../src/lib/loadSixb"

describe("checkRuntimeHealth", () => {
  test("names the provider that answered instead of a bare ok", async () => {
    const health = await checkRuntimeHealth(runtime())

    // Every row used to be the same `{ ok: true, message: "configured" }` literal, so the
    // panel could not tell an operator which implementation had answered — or whether
    // anything had.
    expect(health.storage).toEqual({ ok: true, message: "ok · InMemoryStorage" })
    expect(health.timeseries).toEqual({ ok: true, message: "ok · InMemoryStorage" })
    expect(health.broker).toEqual({ ok: true, message: "ok · InMemoryBroker" })
  })

  test("does not claim a current schema when there is no schema to check", async () => {
    const health = await checkRuntimeHealth(runtime())

    // `InMemoryStorage` exposes no migrators, so nothing was read. Usable, but for want
    // of a schema rather than by having a verified one.
    expect(health.storage.message).not.toContain("schema")
  })

  test("reports a verified schema separately from a merely reachable one", async () => {
    const health = await checkRuntimeHealth(runtime({ migrators: [migrator("current")] }))

    expect(health.storage).toEqual({ ok: true, message: "ok · InMemoryStorage · schema current" })
  })

  test("carries the adapter's own remedy for a schema behind the build", async () => {
    const health = await checkRuntimeHealth(runtime({ migrators: [migrator("pending")] }))

    expect(health.storage.ok).toBe(false)
    // Core owns this wording, and `/ready` prints the same string. The command adds the
    // configured class in front so one provider does not appear under two names — core
    // names the migration adapter, which is not what an author wrote in sixb.config.ts.
    expect(health.storage.message).toBe(
      "InMemoryStorage · Fixture: pending — 1 migration(s) are not applied. Run `sixb db migrate`."
    )
  })

  test("reports an unreachable storage without going on to read its schema", async () => {
    let statusCalls = 0
    const storage = Object.assign(new InMemoryStorage(), {
      migrators: [
        {
          ...migrator("current"),
          status: async () => {
            statusCalls += 1
            return currentStatus()
          },
        },
      ],
      ping: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:5432")
      },
    })

    const health = await checkRuntimeHealth({ ...runtime(), storage } as unknown as LoadedSixb)

    expect(health.storage).toEqual({
      ok: false,
      message: "InMemoryStorage · connect ECONNREFUSED 127.0.0.1:5432",
    })
    // Nothing to learn from a schema read against a host that will not answer, and it
    // would double the wait before the panel prints.
    expect(statusCalls).toBe(0)
  })

  test("bounds a probe that never settles", async () => {
    const storage = Object.assign(new InMemoryStorage(), {
      ping: () => new Promise<void>(() => {}),
    })

    const health = await checkRuntimeHealth({ ...runtime(), storage } as unknown as LoadedSixb, {
      timeoutMs: 25,
    })

    // An unreachable Postgres waits rather than refusing. Without a bound the command
    // hangs, which in a pipeline is indistinguishable from a slow database.
    expect(health.storage).toEqual({ ok: false, message: "InMemoryStorage · timed out after 25ms" })
  })

  test("probes the queues provider through its own health check", async () => {
    const health = await checkRuntimeHealth(runtime())

    // `Queues.health()` is the only read-only member of that contract; everything else
    // enqueues, claims or completes. `InMemoryQueues` implements it, so this row is earned.
    expect(health.queues).toEqual({ ok: true, message: "ok · InMemoryQueues" })
  })

  test("fails the queues row when its health check throws", async () => {
    const queues = Object.assign(new InMemoryQueues(), {
      health: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:6379")
      },
    })

    const health = await checkRuntimeHealth(runtime({ queues }))

    expect(health.queues).toEqual({
      ok: false,
      message: "InMemoryQueues · connect ECONNREFUSED 127.0.0.1:6379",
    })
  })

  test("warns before deployment about providers that cannot cross a process", async () => {
    const health = await checkRuntimeHealth(runtime())

    // Same detection that makes a production role refuse to start, reported at the point
    // where it is still cheap to change — a role refusing to boot is correct but late.
    expect(health.warnings).toHaveLength(2)
    expect(health.warnings.join("\n")).toContain("queues is InMemoryQueues")
    expect(health.warnings.join("\n")).toContain("broker is InMemoryBroker")
    expect(health.warnings.join("\n")).toContain("@sixb/bullmq")
  })

  test("stays quiet when both process-local slots are shareable", async () => {
    const health = await checkRuntimeHealth(
      runtime({ broker: sharedBroker(), queues: sharedQueues() })
    )

    expect(health.warnings).toEqual([])
    expect(health.broker.ok).toBe(true)
  })
})

function runtime(
  overrides: { migrators?: readonly StorageMigrator[]; broker?: unknown; queues?: unknown } = {}
): LoadedSixb {
  const storage = overrides.migrators
    ? Object.assign(new InMemoryStorage(), { migrators: overrides.migrators })
    : new InMemoryStorage()

  return {
    projectId: "cli-health",
    storage,
    broker: overrides.broker ?? new InMemoryBroker(),
    queues: overrides.queues ?? new InMemoryQueues(),
    events: { latestCursor: async () => undefined },
  } as unknown as LoadedSixb
}

/** A broker that declares itself shareable, the way a real one does. */
function sharedBroker() {
  const inner = new InMemoryBroker()
  return new (class SharedBroker {
    scope = "shared" as const
    latestCursor = inner.latestCursor.bind(inner)
  })()
}

function sharedQueues() {
  const inner = new InMemoryQueues()
  return new (class SharedQueues {
    scope = "shared" as const
    health = inner.health.bind(inner)
  })()
}

function currentStatus(): MigrationStatus {
  return { adapterId: "Fixture", latestVersion: 1, appliedVersion: 1, state: "current" }
}

function migrator(state: "current" | "pending"): StorageMigrator {
  return {
    adapterId: "Fixture",
    latestVersion: 1,
    status: async () =>
      state === "current"
        ? currentStatus()
        : {
            adapterId: "Fixture",
            latestVersion: 1,
            appliedVersion: 0,
            state: "pending" as const,
            reason: "1 migration(s) are not applied. Run `sixb db migrate`.",
          },
    migrate: async () => ({
      adapterId: "Fixture",
      latestVersion: 1,
      status: "current" as const,
      applied: [],
      skipped: [],
    }),
  }
}
