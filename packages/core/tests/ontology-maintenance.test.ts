import { describe, expect, test } from "bun:test"
import { InMemoryBroker, InMemoryStorage } from "../src"
import { EventsRuntime, OntologyOutboxDispatcher } from "../src/events"
import { OntologyMaintenance } from "../src/maintenance"
import { getInMemoryOntologyStorageTestingAdapter } from "../src/storage/ontology/in-memory/testing"
import { createMaterializerFixture } from "./materializer-fixture"

describe("OntologyMaintenance", () => {
  test("does not start timers from construction and drains once when hosted", async () => {
    const storage = new InMemoryStorage()
    const broker = new InMemoryBroker()
    const events = new EventsRuntime({ projectId: "project", broker, host: null })
    const dispatcher = new OntologyOutboxDispatcher({ projectId: "project", storage, events })
    const maintenance = new OntologyMaintenance({
      projectId: "project",
      storage,
      dispatcher,
      options: { intervalMs: 60_000 },
    })
    const { materializer } = createMaterializerFixture({ storage })
    await seedObject(materializer)

    await Bun.sleep(20)
    expect(await events.read()).toHaveLength(0)

    const handle = await maintenance.start()
    await waitFor(async () => (await events.read()).length === 1)
    expect(await events.read()).toHaveLength(1)
    expect(maintenance.getSnapshot()).toMatchObject({
      running: false,
      consecutiveFailures: 0,
      outbox: { pendingCount: 0, retryingCount: 0 },
    })
    await handle.stop()
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
    await Bun.sleep(20)
    expect(dispatcher.maxConcurrent).toBe(1)
    expect(dispatcher.calls).toBe(1)

    dispatcher.release()
    const handle = await starting
    await Bun.sleep(20)
    expect(dispatcher.maxConcurrent).toBe(1)
    expect(dispatcher.calls).toBeGreaterThan(1)
    await handle.stop()
  })

  test("shares one loop across multiple lifecycle owners", async () => {
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
    expect(dispatcher.calls).toBe(1)

    await first.stop()
    await waitFor(() => dispatcher.calls > 1)
    await second.stop()
    const callsAfterStop = dispatcher.calls
    await Bun.sleep(15)

    expect(dispatcher.calls).toBe(callsAfterStop)
  })

  test("degrades only after repeated or overdue delivery failures", async () => {
    const storage = new InMemoryStorage()
    const events = new EventsRuntime({
      projectId: "project",
      broker: new UnavailableBroker(),
      host: null,
    })
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

  test("purges only old published rows during a bounded pass", async () => {
    const storage = new InMemoryStorage()
    const broker = new InMemoryBroker()
    const events = new EventsRuntime({ projectId: "project", broker, host: null })
    const now = new Date("2026-06-02T00:00:00.000Z")
    const dispatcher = new OntologyOutboxDispatcher({
      projectId: "project",
      storage,
      events,
      now: () => new Date("2026-06-01T00:00:00.000Z"),
    })
    const { materializer } = createMaterializerFixture({ storage })
    await seedObject(materializer)
    await dispatcher.drain()
    expect(outboxRows(storage)).toHaveLength(1)

    const maintenance = new OntologyMaintenance({
      projectId: "project",
      storage,
      dispatcher,
      now: () => now,
      options: { publishedOutboxRetentionMs: 1, intervalMs: 60_000 },
    })
    const handle = await maintenance.start()
    await waitFor(() => outboxRows(storage).length === 0)

    expect(outboxRows(storage)).toHaveLength(0)
    expect(maintenance.getSnapshot().cleanup?.publishedOutboxRowsDeleted).toBe(1)
    await handle.stop()
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
      events: new EventsRuntime({ projectId: "project", broker: new InMemoryBroker(), host: null }),
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
      events: new EventsRuntime({ projectId: "project", broker: new InMemoryBroker(), host: null }),
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

function outboxRows(storage: InMemoryStorage) {
  return [...getInMemoryOntologyStorageTestingAdapter(storage.ontology).snapshot().outbox.values()]
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 1_000
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return
    await Bun.sleep(5)
  }
  throw new Error("Timed out waiting for maintenance condition.")
}
