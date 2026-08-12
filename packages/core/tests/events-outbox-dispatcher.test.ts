import { describe, expect, test } from "bun:test"
import {
  InMemoryBroker,
  InMemoryStorage,
  type Storage,
  type StorageTransactionOptions,
} from "../src"
import { DomainEventService, OntologyOutboxDispatcher, type StoredDomainEvent } from "../src/events"
import type { OntologyMaterializationEvent } from "../src/storage"
import { getInMemoryOntologyStorageTestingAdapter } from "../src/storage/ontology/in-memory/testing"
import { createMaterializerFixture } from "./materializer-fixture"

const NOW = new Date("2026-01-02T03:04:05.000Z")

describe("DomainEventService stable envelope publication", () => {
  test("preserves the persisted envelope and uses its event ID as broker idempotency key", async () => {
    const broker = new RecordingBroker()
    const events = new DomainEventService({ projectId: "project", broker })
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
    const events = new DomainEventService({ projectId: "project", broker: new InMemoryBroker() })
    await expect(
      events.publishEnvelopes([{ ...objectCreatedEnvelope("event-1"), projectId: "other" }])
    ).rejects.toThrow("belongs to project 'other'")
  })
})

describe("OntologyOutboxDispatcher", () => {
  test("claims in a short transaction, publishes outside it, and acknowledges the lease", async () => {
    const storage = new TransactionTrackingStorage()
    const broker = new OutsideTransactionBroker(storage)
    const events = new DomainEventService({ projectId: "project", broker })
    const { materializer } = createMaterializerFixture({ storage })
    await seedObjectCreated(materializer, "request-1", "one")
    const [outboxRow] = outboxRows(storage)

    const dispatcher = new OntologyOutboxDispatcher({
      projectId: "project",
      storage,
      events,
      now: () => NOW,
      createLeaseId: () => "lease-1",
    })
    await dispatcher.drain()
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
    const events = new DomainEventService({ projectId: "project", broker })
    const { materializer } = createMaterializerFixture({ storage })
    await seedObjectCreated(materializer, "request-batch-1", "batch-one")
    await seedObjectCreated(materializer, "request-batch-2", "batch-two")
    const expectedIds = outboxRows(storage).map((row) => row.envelope.id)

    const dispatcher = new OntologyOutboxDispatcher({
      projectId: "project",
      storage,
      events,
      batchSize: 100,
      now: () => NOW,
      createLeaseId: () => "lease-batch",
    })
    await dispatcher.drain()
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
    const events = new DomainEventService({ projectId: "project", broker })
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
      createLeaseId: () => `dispatcher-lease-${broker.attempts + 1}`,
    })
    await dispatcher.drain()

    nowMs = Date.parse("2026-01-02T03:04:05.125Z")
    await dispatcher.drain()

    nowMs = Date.parse("2026-01-02T03:04:05.325Z")
    await dispatcher.drain()
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
    const events = new DomainEventService({ projectId: "project", broker })
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
    const failures: { readonly attempts: number; readonly eventIds: readonly string[] }[] = []

    const dispatcher = new OntologyOutboxDispatcher({
      projectId: "project",
      storage,
      events,
      now: () => NOW,
      random: () => 0.5,
      initialRetryDelayMs: 100,
      maxRetryDelayMs: 1_000,
      retryJitterRatio: 0,
      createLeaseId: () => "mixed-attempt-lease",
      onDeliveryFailure: (_error, failure) => failures.push(failure),
    })
    await dispatcher.drain()
    await dispatcher.stop()

    const rows = outboxRows(storage)
    expect(broker.attempts).toBe(3)
    expect(rows.find((row) => row.envelope.id === olderId)).toMatchObject({
      attempts: 2,
      availableAt: "2026-01-02T03:04:05.200Z",
    })
    expect(rows.find((row) => row.envelope.id === newerId)).toMatchObject({
      attempts: 1,
      availableAt: "2026-01-02T03:04:05.100Z",
    })
    expect([...failures].sort((left, right) => left.attempts - right.attempts)).toEqual([
      expect.objectContaining({ attempts: 1, eventIds: [newerId] }),
      expect.objectContaining({ attempts: 2, eventIds: [olderId] }),
    ])
  })

  test("stops a drain pass after a fully failed claim instead of walking the backlog", async () => {
    const storage = new InMemoryStorage()
    const broker = new FailingBroker()
    const events = new DomainEventService({ projectId: "project", broker })
    const { materializer } = createMaterializerFixture({ storage })
    for (let index = 0; index < 5; index += 1) {
      await seedObjectCreated(materializer, `request-${index}`, `device-${index}`)
    }
    const failures: { readonly attempts: number; readonly eventIds: readonly string[] }[] = []
    const dispatcher = new OntologyOutboxDispatcher({
      projectId: "project",
      storage,
      events,
      batchSize: 2,
      now: () => NOW,
      retryJitterRatio: 0,
      onDeliveryFailure: (_error, failure) => failures.push(failure),
    })

    await dispatcher.drain()

    expect(broker.attempts).toBe(3)
    expect(outboxRows(storage).filter((row) => row.attempts === 1)).toHaveLength(2)
    expect(outboxRows(storage).filter((row) => row.attempts === 0)).toHaveLength(3)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.eventIds).toHaveLength(2)
    await dispatcher.stop()
  })

  test("rearms healthy catch-up after a bounded drain slice", async () => {
    const storage = new InMemoryStorage()
    const broker = new RecordingBroker()
    const events = new DomainEventService({ projectId: "project", broker })
    const { materializer } = createMaterializerFixture({ storage })
    for (let index = 0; index < 3; index += 1) {
      await seedObjectCreated(materializer, `request-bounded-${index}`, `bounded-${index}`)
    }
    const dispatcher = new OntologyOutboxDispatcher({
      projectId: "project",
      storage,
      events,
      batchSize: 1,
      maxClaimsPerDrain: 2,
    })

    await dispatcher.drain()
    await waitFor(() => outboxRows(storage).filter((row) => row.publishedAt !== null).length === 3)

    expect(outboxRows(storage).filter((row) => row.publishedAt !== null)).toHaveLength(3)
    await dispatcher.stop()
  })

  test("publishes only when explicitly drained and never starts an idle polling loop", async () => {
    const storage = new InMemoryStorage()
    const broker = new RecordingBroker()
    const events = new DomainEventService({ projectId: "project", broker })
    const { materializer } = createMaterializerFixture({ storage })
    const dispatcher = new OntologyOutboxDispatcher({
      projectId: "project",
      storage,
      events,
    })

    await seedObjectCreated(materializer, "request-wake", "wake")
    await dispatcher.drain()

    await seedObjectCreated(materializer, "request-poll", "poll")
    await Bun.sleep(30)
    expect(broker.appended).toHaveLength(1)
    await dispatcher.drain()
    await dispatcher.stop()

    expect((await events.read()).map(objectPrimaryId)).toEqual(["wake", "poll"])
  })

  test("isolates a poison envelope and reschedules only that row", async () => {
    const storage = new InMemoryStorage()
    const { materializer } = createMaterializerFixture({ storage })
    await seedObjectCreated(materializer, "request-valid-1", "valid-1")
    await seedObjectCreated(materializer, "request-poison", "poison")
    await seedObjectCreated(materializer, "request-valid-2", "valid-2")
    const poisonId = outboxRows(storage).find(
      (row) => row.envelope.partitionKey === "Device:poison"
    )!.envelope.id
    const broker = new PoisonEnvelopeBroker(poisonId)
    const events = new DomainEventService({ projectId: "project", broker })
    const failures: { readonly attempts: number; readonly eventIds: readonly string[] }[] = []
    const dispatcher = new OntologyOutboxDispatcher({
      projectId: "project",
      storage,
      events,
      now: () => NOW,
      retryJitterRatio: 0,
      onDeliveryFailure: (_error, failure) => failures.push(failure),
    })

    await dispatcher.drain()

    const rows = outboxRows(storage)
    expect(rows.filter((row) => row.publishedAt !== null)).toHaveLength(2)
    expect(rows.find((row) => row.envelope.id === poisonId)).toMatchObject({
      publishedAt: null,
      leaseId: null,
      lastError: "Error: poison envelope",
    })
    expect(failures).toMatchObject([{ attempts: 1, eventIds: [poisonId] }])
    expect((await events.read()).map(objectPrimaryId).sort()).toEqual(["valid-1", "valid-2"])
  })

  test("isolates one poison envelope from the default large publication batch", async () => {
    const storage = new InMemoryStorage()
    const { materializer } = createMaterializerFixture({ storage })
    await materializer.edits.commit({
      mode: "atomic",
      source: { kind: "runtime", requestId: "request-large-poison-batch" },
      operations: Array.from({ length: 1_000 }, (_, index) => ({
        id: `create-large-${index}`,
        kind: "object.create" as const,
        ref: { objectTypeId: "Device", primaryId: `large-${index}` },
        properties: { name: `large-${index}` },
      })),
      expectedObjects: [],
      expectedLinks: [],
      expectedLinkScopes: [],
    })
    const poisonId = outboxRows(storage)[731]!.envelope.id
    const broker = new PoisonEnvelopeBroker(poisonId)
    const events = new DomainEventService({ projectId: "project", broker })
    const dispatcher = new OntologyOutboxDispatcher({
      projectId: "project",
      storage,
      events,
      now: () => NOW,
      retryJitterRatio: 0,
    })

    await dispatcher.drain()

    const rows = outboxRows(storage)
    expect(rows.filter((row) => row.publishedAt !== null)).toHaveLength(999)
    expect(rows.find((row) => row.envelope.id === poisonId)).toMatchObject({
      publishedAt: null,
      leaseId: null,
      lastError: "Error: poison envelope",
    })
    expect(await events.read({ limit: 1_000 })).toHaveLength(999)
  })

  test("coalesces a drain that arrives during an in-flight publication", async () => {
    const storage = new InMemoryStorage()
    const broker = new FirstHeldBroker()
    const events = new DomainEventService({ projectId: "project", broker })
    const { materializer } = createMaterializerFixture({ storage })
    await seedObjectCreated(materializer, "request-poll", "poll")

    const dispatcher = new OntologyOutboxDispatcher({
      projectId: "project",
      storage,
      events,
      shutdownTimeoutMs: 1_000,
    })
    const firstDrain = dispatcher.drain()
    await broker.firstStarted.promise

    await seedObjectCreated(materializer, "request-drain", "drain")
    const secondDrain = dispatcher.drain()

    broker.releaseFirst.resolve()
    await Promise.all([firstDrain, secondDrain])
    await dispatcher.stop()

    expect(outboxRows(storage).map((row) => row.publishedAt !== null)).toEqual([true, true])
  })

  test("coalesces drains that arrive while a pass is running", async () => {
    // A burst of concurrent commits must not each pay for its own sequential claim pass.
    const storage = new TransactionTrackingStorage()
    const events = new DomainEventService({ projectId: "project", broker: new RecordingBroker() })
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
    const events = new DomainEventService({ projectId: "project", broker })
    const { materializer } = createMaterializerFixture({ storage })
    await seedObjectCreated(materializer, "request-drain", "drain")
    const dispatcher = new OntologyOutboxDispatcher({
      projectId: "project",
      storage,
      events,
      shutdownTimeoutMs: 1_000,
    })
    void dispatcher.drain()
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

  test("shares one concurrent stop operation", async () => {
    const storage = new InMemoryStorage()
    const broker = new DelayedBroker()
    const events = new DomainEventService({ projectId: "project", broker })
    const { materializer } = createMaterializerFixture({ storage })
    await seedObjectCreated(materializer, "request-concurrent-stop", "concurrent-stop")
    const dispatcher = new OntologyOutboxDispatcher({
      projectId: "project",
      storage,
      events,
      shutdownTimeoutMs: 1_000,
    })
    void dispatcher.drain()
    await broker.started.promise

    const firstStop = dispatcher.stop()
    const secondStop = dispatcher.stop()
    expect(secondStop).toBe(firstStop)

    broker.release.resolve()
    await Promise.all([firstStop, secondStop])
    expect(outboxRows(storage)[0]?.publishedAt).not.toBeNull()
  })

  test("reschedules an unfinished publication when the graceful shutdown bound expires", async () => {
    const storage = new InMemoryStorage()
    const broker = new DelayedBroker()
    const events = new DomainEventService({ projectId: "project", broker })
    const { materializer } = createMaterializerFixture({ storage })
    await seedObjectCreated(materializer, "request-stop", "stop")
    const dispatcher = new OntologyOutboxDispatcher({
      projectId: "project",
      storage,
      events,
      now: () => NOW,
      shutdownTimeoutMs: 5,
      createLeaseId: () => "shutdown-lease",
    })
    void dispatcher.drain()
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

class PoisonEnvelopeBroker extends RecordingBroker {
  constructor(private readonly poisonId: string) {
    super()
  }

  override append(
    input: Parameters<InMemoryBroker["append"]>[0]
  ): ReturnType<InMemoryBroker["append"]> {
    if (input.records.some((record) => record.idempotencyKey === this.poisonId)) {
      return Promise.reject(new Error("poison envelope"))
    }
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
