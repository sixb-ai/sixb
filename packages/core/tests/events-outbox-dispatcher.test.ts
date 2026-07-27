import { describe, expect, test } from "bun:test"
import {
  InMemoryBroker,
  InMemoryStorage,
  type Storage,
  type StorageTransactionOptions,
} from "../src"
import { EventsRuntime, OntologyOutboxDispatcher, type StoredDomainEvent } from "../src/events"
import type { OntologyMaterializationEvent } from "../src/storage"
import { getInMemoryOntologyStorageTestingAdapter } from "../src/storage/ontology/in-memory/testing"
import { createMaterializerFixture } from "./materializer-fixture"

const NOW = new Date("2026-01-02T03:04:05.000Z")

describe("EventsRuntime stable envelope publication", () => {
  test("preserves the persisted envelope and uses its event ID as broker idempotency key", async () => {
    const broker = new RecordingBroker()
    const events = new EventsRuntime({ projectId: "project", broker })
    const envelope = objectCreatedEnvelope("event-stable")

    const [published] = await events.publishEnvelopes([envelope])
    const [replayed] = await events.publishEnvelopes([envelope])

    expect(published).toMatchObject({
      ...envelope,
      cursor: "1",
    })
    expect(replayed?.id).toBe(envelope.id)
    expect(broker.appended.map((input) => input.records[0]?.idempotencyKey)).toEqual([
      "event-stable",
      "event-stable",
    ])
    expect((await events.read()).map((event) => event.id)).toEqual(["event-stable", "event-stable"])
  })

  test("rejects stable envelopes for another project", async () => {
    const events = new EventsRuntime({ projectId: "project", broker: new InMemoryBroker() })
    await expect(
      events.publishEnvelopes([{ ...objectCreatedEnvelope("event-1"), projectId: "other" }])
    ).rejects.toThrow("belongs to project 'other'")
  })
})

describe("OntologyOutboxDispatcher", () => {
  test("claims in a short transaction, publishes outside it, and acknowledges the lease", async () => {
    const storage = new TransactionTrackingStorage()
    const broker = new OutsideTransactionBroker(storage)
    const events = new EventsRuntime({ projectId: "project", broker })
    const { materializer } = createMaterializerFixture({ storage })
    await seedObjectCreated(materializer, "request-1", "one")
    const [outboxRow] = outboxRows(storage)

    const dispatcher = new OntologyOutboxDispatcher({
      projectId: "project",
      storage,
      events,
      pollIntervalMs: 10,
      now: () => NOW,
      createLeaseId: () => "lease-1",
    })
    await dispatcher.start()
    await waitFor(() => outboxRows(storage)[0]?.publishedAt !== null)
    await dispatcher.stop()

    expect((await events.read()).map((event) => event.id)).toEqual([outboxRow?.envelope.id])
    expect(broker.publicationTransactionDepths).toEqual([0])
    expect(storage.transactionCount).toBeGreaterThanOrEqual(2)
    expect(outboxRows(storage)[0]).toMatchObject({
      leaseId: null,
      leaseExpiresAt: null,
      publishedAt: NOW.toISOString(),
    })
  })

  test("publishes and acknowledges each claimed lease as one batch", async () => {
    const storage = new TransactionTrackingStorage()
    const broker = new RecordingBroker()
    const events = new EventsRuntime({ projectId: "project", broker })
    const { materializer } = createMaterializerFixture({ storage })
    await seedObjectCreated(materializer, "request-batch-1", "batch-one")
    await seedObjectCreated(materializer, "request-batch-2", "batch-two")
    const expectedIds = outboxRows(storage).map((row) => row.envelope.id)

    const dispatcher = new OntologyOutboxDispatcher({
      projectId: "project",
      storage,
      events,
      batchSize: 100,
      pollIntervalMs: 10,
      now: () => NOW,
      createLeaseId: () => "lease-batch",
    })
    await dispatcher.start()
    await waitFor(() => outboxRows(storage).every((row) => row.publishedAt !== null))
    await dispatcher.stop()

    expect(broker.appended).toHaveLength(1)
    // Both rows ride one claimed lease. Delivery is at-least-once and commitOrdinal only correlates
    // facts within a commit; this assertion deliberately pins contents, not broker delivery order.
    expect(
      [...(broker.appended[0]?.records ?? [])].map((record) => record.idempotencyKey).sort()
    ).toEqual([...expectedIds].sort())
    expect(outboxRows(storage).every((row) => row.leaseId === null)).toBe(true)
  })

  test("reschedules publication failures with deterministic bounded exponential jitter", async () => {
    const storage = new InMemoryStorage()
    const broker = new FailingBroker()
    const events = new EventsRuntime({ projectId: "project", broker })
    const { materializer } = createMaterializerFixture({ storage })
    await seedObjectCreated(materializer, "request-retry", "retry")
    let nowMs = NOW.getTime()
    const randomValues = [1, 0.5, 1]

    const dispatcher = new OntologyOutboxDispatcher({
      projectId: "project",
      storage,
      events,
      now: () => new Date(nowMs),
      random: () => randomValues.shift() ?? 0.5,
      initialRetryDelayMs: 100,
      maxRetryDelayMs: 250,
      retryJitterRatio: 0.25,
      pollIntervalMs: 10,
      createLeaseId: () => `dispatcher-lease-${broker.attempts + 1}`,
    })
    await dispatcher.start()
    await broker.attempted.promise
    await waitFor(
      () =>
        outboxRows(storage)[0]?.attempts === 1 &&
        outboxRows(storage)[0]?.availableAt === "2026-01-02T03:04:05.125Z"
    )

    nowMs = Date.parse("2026-01-02T03:04:05.125Z")
    dispatcher.wake()
    await waitFor(
      () =>
        outboxRows(storage)[0]?.attempts === 2 &&
        outboxRows(storage)[0]?.availableAt === "2026-01-02T03:04:05.325Z"
    )

    nowMs = Date.parse("2026-01-02T03:04:05.325Z")
    dispatcher.wake()
    await waitFor(
      () =>
        outboxRows(storage)[0]?.attempts === 3 &&
        outboxRows(storage)[0]?.availableAt === "2026-01-02T03:04:05.575Z"
    )
    await dispatcher.stop()

    expect(outboxRows(storage)[0]).toMatchObject({
      attempts: 3,
      availableAt: "2026-01-02T03:04:05.575Z",
      leaseId: null,
      leaseExpiresAt: null,
      lastError: "Error: broker unavailable",
    })
    expect(
      await storage.ontology.outbox.claim({
        projectId: "project",
        now: "2026-01-02T03:04:05.574Z",
        limit: 1,
        leaseId: "too-early",
        leaseExpiresAt: "2026-01-02T03:05:05.574Z",
      })
    ).toEqual([])
    expect(
      await storage.ontology.outbox.claim({
        projectId: "project",
        now: "2026-01-02T03:04:05.575Z",
        limit: 1,
        leaseId: "retry-lease",
        leaseExpiresAt: "2026-01-02T03:05:05.575Z",
      })
    ).toHaveLength(1)
  })

  test("keeps retry backoff per attempt group while publishing one claimed batch", async () => {
    const storage = new InMemoryStorage()
    const broker = new FailingBroker()
    const events = new EventsRuntime({ projectId: "project", broker })
    const { materializer } = createMaterializerFixture({ storage })
    await seedObjectCreated(materializer, "request-older", "older")
    const olderId = outboxRows(storage)[0]!.envelope.id
    const [olderClaim] = await storage.ontology.outbox.claim({
      projectId: "project",
      now: NOW.toISOString(),
      limit: 1,
      leaseId: "older-lease",
      leaseExpiresAt: new Date(NOW.getTime() + 1_000).toISOString(),
    })
    await storage.ontology.outbox.reschedule({
      projectId: "project",
      ids: [olderId],
      leaseId: olderClaim!.leaseId,
      availableAt: NOW.toISOString(),
      error: "seed retry",
    })
    await seedObjectCreated(materializer, "request-newer", "newer")
    const newerId = outboxRows(storage).find((row) => row.envelope.id !== olderId)!.envelope.id

    const dispatcher = new OntologyOutboxDispatcher({
      projectId: "project",
      storage,
      events,
      now: () => NOW,
      random: () => 0.5,
      initialRetryDelayMs: 100,
      maxRetryDelayMs: 1_000,
      retryJitterRatio: 0,
      pollIntervalMs: 10,
      createLeaseId: () => "mixed-attempt-lease",
    })
    await dispatcher.start()
    await broker.attempted.promise
    await waitFor(() => outboxRows(storage).every((row) => row.leaseId === null))
    await dispatcher.stop()

    const rows = outboxRows(storage)
    expect(broker.attempts).toBe(1)
    expect(rows.find((row) => row.envelope.id === olderId)).toMatchObject({
      attempts: 2,
      availableAt: "2026-01-02T03:04:05.200Z",
    })
    expect(rows.find((row) => row.envelope.id === newerId)).toMatchObject({
      attempts: 1,
      availableAt: "2026-01-02T03:04:05.100Z",
    })
  })

  test("wakes promptly and still discovers rows by polling without a wake notification", async () => {
    const storage = new InMemoryStorage()
    const broker = new RecordingBroker()
    const events = new EventsRuntime({ projectId: "project", broker })
    const { materializer } = createMaterializerFixture({ storage })
    const dispatcher = new OntologyOutboxDispatcher({
      projectId: "project",
      storage,
      events,
      pollIntervalMs: 20,
    })
    await dispatcher.start()

    await seedObjectCreated(materializer, "request-wake", "wake")
    dispatcher.wake()
    await waitFor(() => broker.appended.length === 1)

    await seedObjectCreated(materializer, "request-poll", "poll")
    await waitFor(() => broker.appended.length === 2)
    await dispatcher.stop()

    expect((await events.read()).map(objectPrimaryId)).toEqual(["wake", "poll"])
  })

  test("settles a poll-loop publication that overlaps a concurrent drain", async () => {
    // Both ingresses publish, so two batches can be in flight at once. Neither may evict the
    // other's settlement, or its rows stay leased and are delivered again after lease expiry.
    const storage = new InMemoryStorage()
    const broker = new FirstHeldBroker()
    const events = new EventsRuntime({ projectId: "project", broker })
    const { materializer } = createMaterializerFixture({ storage })
    await seedObjectCreated(materializer, "request-poll", "poll")

    const dispatcher = new OntologyOutboxDispatcher({
      projectId: "project",
      storage,
      events,
      pollIntervalMs: 10,
      shutdownTimeoutMs: 1_000,
    })
    await dispatcher.start()
    await broker.firstStarted.promise

    // A second commit drains while the poll loop's publication is still awaiting the broker.
    await seedObjectCreated(materializer, "request-drain", "drain")
    await dispatcher.drain()

    broker.releaseFirst.resolve()
    await waitFor(() => outboxRows(storage).every((row) => row.publishedAt !== null))
    await dispatcher.stop()

    expect(outboxRows(storage).map((row) => row.publishedAt !== null)).toEqual([true, true])
  })

  test("coalesces drains that arrive while a pass is running", async () => {
    // A burst of concurrent commits must not each pay for its own sequential claim pass.
    const storage = new TransactionTrackingStorage()
    const events = new EventsRuntime({ projectId: "project", broker: new RecordingBroker() })
    const { materializer } = createMaterializerFixture({ storage })
    await seedObjectCreated(materializer, "request-burst", "burst")

    const dispatcher = new OntologyOutboxDispatcher({ projectId: "project", storage, events })
    const before = storage.transactionCount
    await Promise.all(Array.from({ length: 20 }, () => dispatcher.drain()))

    // One pass for the first caller plus one shared follow-up for everyone who arrived during it.
    expect(storage.transactionCount - before).toBeLessThanOrEqual(4)
    expect(outboxRows(storage)[0]?.publishedAt).not.toBeNull()
  })

  test("waits for bounded in-flight publication during graceful stop", async () => {
    const storage = new InMemoryStorage()
    const broker = new DelayedBroker()
    const events = new EventsRuntime({ projectId: "project", broker })
    const { materializer } = createMaterializerFixture({ storage })
    await seedObjectCreated(materializer, "request-drain", "drain")
    const dispatcher = new OntologyOutboxDispatcher({
      projectId: "project",
      storage,
      events,
      pollIntervalMs: 10,
      shutdownTimeoutMs: 1_000,
    })
    await dispatcher.start()
    await broker.started.promise

    let stopped = false
    const stopping = dispatcher.stop().then(() => {
      stopped = true
    })
    await sleep(0)
    expect(stopped).toBe(false)

    broker.release.resolve()
    await stopping
    expect(outboxRows(storage)[0]?.publishedAt).not.toBeNull()
  })

  test("detaches an uncooperative publication so the dispatcher can restart", async () => {
    const storage = new InMemoryStorage()
    const broker = new FirstHungBroker()
    const events = new EventsRuntime({ projectId: "project", broker })
    const { materializer } = createMaterializerFixture({ storage })
    await seedObjectCreated(materializer, "request-restart", "restart")
    let lease = 0
    const dispatcher = new OntologyOutboxDispatcher({
      projectId: "project",
      storage,
      events,
      now: () => NOW,
      pollIntervalMs: 10,
      shutdownTimeoutMs: 10,
      createLeaseId: () => `restart-lease-${++lease}`,
    })
    await dispatcher.start()
    await broker.firstStarted.promise

    await dispatcher.stop()
    await dispatcher.start()
    dispatcher.wake()
    await waitFor(() => outboxRows(storage)[0]?.publishedAt !== null)
    await dispatcher.stop()

    expect(broker.calls).toBe(2)
  })

  test("reschedules an unfinished publication when the graceful shutdown bound expires", async () => {
    const storage = new InMemoryStorage()
    const broker = new DelayedBroker()
    const events = new EventsRuntime({ projectId: "project", broker })
    const { materializer } = createMaterializerFixture({ storage })
    await seedObjectCreated(materializer, "request-stop", "stop")
    const dispatcher = new OntologyOutboxDispatcher({
      projectId: "project",
      storage,
      events,
      now: () => NOW,
      pollIntervalMs: 10,
      shutdownTimeoutMs: 5,
      createLeaseId: () => "shutdown-lease",
    })
    await dispatcher.start()
    await broker.started.promise

    await dispatcher.stop()
    expect(outboxRows(storage)[0]).toMatchObject({
      availableAt: NOW.toISOString(),
      leaseId: null,
      leaseExpiresAt: null,
      lastError: "Outbox dispatcher stopped before publication completed.",
    })

    broker.release.resolve()
    await waitFor(() => broker.appended.length === 1)
    await dispatcher.stop()
  })
})

function objectCreatedEnvelope(id: string): OntologyMaterializationEvent {
  return {
    id,
    schemaVersion: 1,
    projectId: "project",
    occurredAt: NOW.toISOString(),
    origin: { kind: "runtime", requestId: "request-1" },
    commitId: "commit-1",
    commitOrdinal: 0,
    type: "object.created",
    topic: "objects",
    partitionKey: "Device:one",
    payload: {
      objectTypeId: "Device",
      primaryId: "one",
      properties: { name: "one" },
      propertyChanges: { name: { operation: "created", after: "one" } },
    },
  }
}

async function seedObjectCreated(
  materializer: ReturnType<typeof createMaterializerFixture>["materializer"],
  requestId: string,
  primaryId: string
): Promise<void> {
  await materializer.edits.commit({
    mode: "atomic",
    source: { kind: "runtime", requestId },
    operations: [
      {
        id: `create-${primaryId}`,
        kind: "object.create",
        ref: { objectTypeId: "Device", primaryId },
        properties: { name: primaryId },
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

function objectPrimaryId(event: StoredDomainEvent): string | undefined {
  if (event.type !== "object.created") return undefined
  const payload = event.payload
  if (typeof payload !== "object" || payload === null || !("primaryId" in payload)) return undefined
  return typeof payload.primaryId === "string" ? payload.primaryId : undefined
}

class RecordingBroker extends InMemoryBroker {
  readonly appended: Parameters<InMemoryBroker["append"]>[0][] = []

  override append(
    input: Parameters<InMemoryBroker["append"]>[0]
  ): ReturnType<InMemoryBroker["append"]> {
    this.appended.push(input)
    return super.append(input)
  }
}

class TransactionTrackingStorage extends InMemoryStorage {
  transactionDepth = 0
  transactionCount = 0

  override async transaction<T>(
    run: (tx: Storage) => Promise<T> | T,
    options?: StorageTransactionOptions
  ): Promise<T> {
    this.transactionCount += 1
    return super.transaction(async (tx) => {
      this.transactionDepth += 1
      try {
        return await run(tx)
      } finally {
        this.transactionDepth -= 1
      }
    }, options)
  }
}

class OutsideTransactionBroker extends RecordingBroker {
  readonly publicationTransactionDepths: number[] = []

  constructor(private readonly storage: TransactionTrackingStorage) {
    super()
  }

  override append(
    input: Parameters<InMemoryBroker["append"]>[0]
  ): ReturnType<InMemoryBroker["append"]> {
    this.publicationTransactionDepths.push(this.storage.transactionDepth)
    return super.append(input)
  }
}

class FailingBroker extends InMemoryBroker {
  readonly attempted = deferred<void>()
  attempts = 0

  override append(
    _input: Parameters<InMemoryBroker["append"]>[0]
  ): ReturnType<InMemoryBroker["append"]> {
    this.attempts += 1
    this.attempted.resolve()
    return Promise.reject(new Error("broker unavailable"))
  }
}

class FirstHungBroker extends RecordingBroker {
  readonly firstStarted = deferred<void>()
  calls = 0

  override append(
    input: Parameters<InMemoryBroker["append"]>[0]
  ): ReturnType<InMemoryBroker["append"]> {
    this.calls += 1
    if (this.calls === 1) {
      this.firstStarted.resolve()
      return new Promise(() => undefined)
    }
    return super.append(input)
  }
}

/** Holds the first publication open so a second can overlap it. */
class FirstHeldBroker extends RecordingBroker {
  readonly firstStarted = deferred<void>()
  readonly releaseFirst = deferred<void>()
  private calls = 0

  override async append(
    input: Parameters<InMemoryBroker["append"]>[0]
  ): ReturnType<InMemoryBroker["append"]> {
    this.calls += 1
    if (this.calls === 1) {
      this.firstStarted.resolve()
      await this.releaseFirst.promise
    }
    return super.append(input)
  }
}

class DelayedBroker extends RecordingBroker {
  readonly started = deferred<void>()
  readonly release = deferred<void>()

  override async append(
    input: Parameters<InMemoryBroker["append"]>[0]
  ): ReturnType<InMemoryBroker["append"]> {
    this.started.resolve()
    await this.release.promise
    return super.append(input)
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition.")
    await sleep(1)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
