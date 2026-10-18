import { afterEach, describe, expect, jest, test } from "bun:test"
import { InMemoryBroker, InMemoryStorage } from "../src"
import { DomainEventService, OntologyOutboxDispatcher } from "../src/events"
import { OntologyMaintenance } from "../src/maintenance"
import { getInMemoryOntologyStorageTestingAdapter } from "../src/storage/ontology/in-memory/testing"
import {
  claimProjectionExecution,
  createMaterializerFixture,
  entries,
  sourceEntry,
} from "./materializer-fixture"

afterEach(() => {
  jest.useRealTimers()
})

describe("OntologyMaintenance", () => {
  // Regression proof: return after settlesWithin times out; cleanup can then access closed storage.
  test("shutdown warns after its grace period but waits for the active maintenance pass", async () => {
    jest.useFakeTimers()
    const storage = new InMemoryStorage()
    const dispatcher = new DelayedDispatcher(storage)
    const errors: unknown[] = []
    const maintenance = new OntologyMaintenance({
      projectId: "project",
      storage,
      dispatcher,
      options: { shutdownTimeoutMs: 5 },
      onError: (error) => errors.push(error),
    })
    const handle = await maintenance.start()
    await dispatcher.started
    let stopped = false
    const stopping = handle.stop().then(() => {
      stopped = true
    })
    try {
      jest.advanceTimersByTime(4)
      await flush()
      expect(errors).toHaveLength(0)

      jest.advanceTimersByTime(1)
      await flush()
      expect(errors).toHaveLength(1)
      expect(String(errors[0])).toContain("still stopping after 5ms")
      expect(stopped).toBe(false)
    } finally {
      dispatcher.release()
      await stopping
    }
    expect(maintenance.getSnapshot().running).toBe(false)
  })

  test("does not start timers from construction and drains once when hosted", async () => {
    jest.useFakeTimers()
    const storage = new InMemoryStorage()
    const broker = new InMemoryBroker()
    const events = new DomainEventService({ projectId: "project", broker })
    const dispatcher = new OntologyOutboxDispatcher({ projectId: "project", storage, events })
    const maintenance = new OntologyMaintenance({
      projectId: "project",
      storage,
      dispatcher,
      options: { intervalMs: 60_000 },
    })
    const { materializer } = createMaterializerFixture({ storage })
    await seedObject(materializer)

    expect(jest.getTimerCount()).toBe(0)
    expect(await events.read()).toHaveLength(0)

    const handle = await maintenance.start()
    await waitFor(() => maintenance.getSnapshot().lastCompletedAt !== null)
    expect(await events.read()).toHaveLength(1)
    expect(maintenance.getSnapshot()).toMatchObject({
      running: false,
      consecutiveFailures: 0,
      outbox: { pendingCount: 0, retryingCount: 0 },
    })
    expect(jest.getTimerCount()).toBe(1)
    await handle.stop()
    expect(jest.getTimerCount()).toBe(0)
  })

  test("returns its handle before startup catch-up completes", async () => {
    const storage = new InMemoryStorage()
    const dispatcher = new DelayedDispatcher(storage)
    const maintenance = new OntologyMaintenance({
      projectId: "project",
      storage,
      dispatcher,
      options: { intervalMs: 60_000 },
    })

    const handle = await maintenance.start()
    await dispatcher.started

    expect(maintenance.getSnapshot().running).toBe(true)
    dispatcher.release()
    await waitFor(() => maintenance.getSnapshot().running === false)
    await handle.stop()
  })

  test("never overlaps periodic passes", async () => {
    jest.useFakeTimers()
    const storage = new InMemoryStorage()
    const dispatcher = new DelayedDispatcher(storage)
    const maintenance = new OntologyMaintenance({
      projectId: "project",
      storage,
      dispatcher,
      options: { intervalMs: 5 },
    })

    const starting = maintenance.start()
    await dispatcher.started
    jest.advanceTimersByTime(20)
    await flush()
    expect(dispatcher.maxConcurrent).toBe(1)
    expect(dispatcher.calls).toBe(1)

    dispatcher.release()
    const handle = await starting
    await flush()
    for (let pass = 0; pass < 3; pass++) {
      jest.advanceTimersByTime(5)
      await flush()
    }
    expect(dispatcher.maxConcurrent).toBe(1)
    expect(dispatcher.calls).toBe(4)
    await handle.stop()
  })

  test("shares one loop across multiple lifecycle owners", async () => {
    jest.useFakeTimers()
    const storage = new InMemoryStorage()
    const dispatcher = new CountingDispatcher(storage)
    const maintenance = new OntologyMaintenance({
      projectId: "project",
      storage,
      dispatcher,
      options: { intervalMs: 5 },
    })

    const first = await maintenance.start()
    const second = await maintenance.start()
    await flush()
    expect(dispatcher.calls).toBe(1)

    await first.stop()
    jest.advanceTimersByTime(5)
    await flush()
    expect(dispatcher.calls).toBe(2)

    await second.stop()
    expect(jest.getTimerCount()).toBe(0)
    jest.advanceTimersByTime(60_000)
    await flush()
    expect(dispatcher.calls).toBe(2)
  })

  test("degrades only after repeated delivery failures", async () => {
    const storage = new InMemoryStorage()
    const events = new DomainEventService({ projectId: "project", broker: new UnavailableBroker() })
    let nowMs = Date.parse("2026-01-02T03:04:05.000Z")
    const dispatcher = new OntologyOutboxDispatcher({
      projectId: "project",
      storage,
      events,
      now: () => new Date(nowMs),
      initialRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      retryJitterRatio: 0,
    })
    const { materializer } = createMaterializerFixture({ storage })
    await seedObject(materializer)
    const maintenance = new OntologyMaintenance({
      projectId: "project",
      storage,
      dispatcher,
      now: () => new Date(nowMs),
      options: { intervalMs: 60_000 },
    })

    const handle = await maintenance.start()
    await waitFor(() => maintenance.getSnapshot().outbox?.maxAttempts === 1)

    expect(maintenance.getOperationalStatus()).toMatchObject({
      status: "ok",
      maintenance: { outbox: { pendingCount: 1, retryingCount: 1, maxAttempts: 1 } },
    })

    nowMs += 1
    await maintenance.runNow()
    nowMs += 2
    await maintenance.runNow()

    expect(maintenance.getOperationalStatus()).toMatchObject({
      status: "degraded",
      maintenance: { outbox: { pendingCount: 1, maxAttempts: 3 } },
    })
    await handle.stop()
  })

  test("purges published rows only once they are older than the retention", async () => {
    const storage = new InMemoryStorage()
    const broker = new InMemoryBroker()
    const events = new DomainEventService({ projectId: "project", broker })
    const publishedAt = Date.parse("2026-06-01T00:00:00.000Z")
    const dispatcher = new OntologyOutboxDispatcher({
      projectId: "project",
      storage,
      events,
      now: () => new Date(publishedAt),
    })
    const { materializer } = createMaterializerFixture({ storage })
    await seedObject(materializer)
    await dispatcher.drain()
    expect(outboxRows(storage)).toHaveLength(1)

    // The cutoff is exclusive: a row published exactly one retention ago stays.
    let nowMs = publishedAt + 1_000
    const maintenance = new OntologyMaintenance({
      projectId: "project",
      storage,
      dispatcher,
      now: () => new Date(nowMs),
      options: { publishedOutboxRetentionMs: 1_000, intervalMs: 60_000 },
    })
    await maintenance.runNow()
    expect(outboxRows(storage)).toHaveLength(1)
    expect(maintenance.getSnapshot().cleanup?.publishedOutboxRowsDeleted).toBe(0)

    nowMs += 1
    await maintenance.runNow()
    expect(outboxRows(storage)).toHaveLength(0)
    expect(maintenance.getSnapshot().cleanup?.publishedOutboxRowsDeleted).toBe(1)
  })

  test("deletes an abandoned candidate on the next pass, whatever the retention", async () => {
    const storage = new InMemoryStorage()
    // One row per stage call: the first root is durable before the duplicate fails.
    const { materializer, projections } = createMaterializerFixture({
      storage,
      dependencies: { batching: { sourceStageRows: 1 } },
    })
    const datasetVersion = {
      datasetId: "devices",
      versionId: "abandoned-in-maintenance",
      createdAt: "2026-01-01T00:00:00.000Z",
    }
    const execution = await claimProjectionExecution(storage, projections, {
      runId: "abandoned-in-maintenance",
      projectionId: "devices",
      protocol: "replacement",
      datasetVersion,
    })
    await expect(
      materializer.projections.replace({
        source: { projectionId: "devices" },
        datasetVersion,
        execution,
        entries: entries([sourceEntry("one", "one"), sourceEntry("one", "one")]),
      })
    ).rejects.toThrow("repeats root")
    await materializer.projections.finishRun({
      protocol: "replacement",
      source: { projectionId: "devices" },
      datasetVersion,
      execution,
      status: "failed",
    })
    expect(sourceVersions(storage)).toHaveLength(1)

    const maintenance = new OntologyMaintenance({
      projectId: "project",
      storage,
      dispatcher: new CountingDispatcher(storage),
      options: { terminalSourceRetentionMs: 24 * 60 * 60_000 },
    })
    await maintenance.runNow()

    expect(sourceVersions(storage)).toHaveLength(0)
    expect(maintenance.getSnapshot().cleanup).toMatchObject({
      terminalSourceRowsDeleted: 2,
      terminalSourceMaterializationsDeleted: 1,
    })
  })
})

class DelayedDispatcher extends OntologyOutboxDispatcher {
  private resolveStarted!: () => void
  private resolveRelease!: () => void
  readonly started = new Promise<void>((resolve) => {
    this.resolveStarted = resolve
  })
  private readonly released = new Promise<void>((resolve) => {
    this.resolveRelease = resolve
  })
  calls = 0
  concurrent = 0
  maxConcurrent = 0

  constructor(storage: InMemoryStorage) {
    super({
      projectId: "project",
      storage,
      events: new DomainEventService({ projectId: "project", broker: new InMemoryBroker() }),
    })
  }

  override async drain(): Promise<void> {
    this.calls += 1
    this.concurrent += 1
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent)
    this.resolveStarted()
    await this.released
    this.concurrent -= 1
  }

  release(): void {
    this.resolveRelease()
  }
}

class UnavailableBroker extends InMemoryBroker {
  override async append(): ReturnType<InMemoryBroker["append"]> {
    throw new Error("Broker unavailable.")
  }
}

class CountingDispatcher extends OntologyOutboxDispatcher {
  calls = 0

  constructor(storage: InMemoryStorage) {
    super({
      projectId: "project",
      storage,
      events: new DomainEventService({ projectId: "project", broker: new InMemoryBroker() }),
    })
  }

  override async drain(): Promise<void> {
    this.calls += 1
  }
}

async function seedObject(
  materializer: ReturnType<typeof createMaterializerFixture>["materializer"]
): Promise<void> {
  await materializer.edits.commit({
    mode: "atomic",
    source: { kind: "runtime", requestId: "request-maintenance" },
    operations: [
      {
        id: "create-maintenance",
        kind: "object.create",
        ref: { objectTypeId: "Device", primaryId: "maintenance" },
        properties: { name: "maintenance" },
      },
    ],
    expectedObjects: [],
    expectedLinks: [],
    expectedLinkScopes: [],
  })
}

function sourceVersions(storage: InMemoryStorage) {
  return [
    ...getInMemoryOntologyStorageTestingAdapter(storage.ontology)
      .snapshot()
      .sourceMaterializations.values(),
  ]
}

function outboxRows(storage: InMemoryStorage) {
  return [...getInMemoryOntologyStorageTestingAdapter(storage.ontology).snapshot().outbox.values()]
}

/** `setImmediate` stays real under Bun's fake timers, so this drains every pending microtask. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** Waits for a pass that needs no timer: every step of it is a promise the loop can drain. */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100; turn++) {
    if (predicate()) return
    await flush()
  }
  throw new Error("Timed out waiting for maintenance condition.")
}
