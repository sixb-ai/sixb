import { afterEach, expect, jest, spyOn, test } from "bun:test"
import { InMemoryBroker, InMemoryStorage } from "../src"
import { DomainEventService, OntologyOutboxDispatcher } from "../src/events"
import type { OntologyOutboxStorage } from "../src/storage"
import { decorateOperationScopedMethodForTesting } from "../src/storage/operation-scope"
import { atomic, createMaterializerFixture } from "./materializer-fixture"

afterEach(() => {
  jest.useRealTimers()
})

/** `setImmediate` stays real under Bun's fake timers, so this drains every pending microtask. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

// Regression proof: remove the macrotask yield between catch-up passes. Bun 1.4.2 then
// delivers the entire in-memory backlog before a pending immediate can run. Remove the rearming
// `notify()` after a full slice instead, and catch-up stops after one bounded drain pass.
test("outbox catch-up yields to the event loop and rearms bounded slices until the backlog drains", async () => {
  const backlog = 100
  const storage = await seededStorage(backlog)
  let delivered = 0
  const observed = Promise.withResolvers<number>()
  const drained = Promise.withResolvers<void>()
  const service = new DomainEventService({ projectId: "project", broker: new InMemoryBroker() })
  const dispatcher = new OntologyOutboxDispatcher({
    projectId: "project",
    storage,
    batchSize: 25,
    maxClaimsPerDrain: 2,
    events: {
      async publishEnvelopes(rows) {
        const result = await service.publishEnvelopes(rows)
        delivered += rows.length
        if (delivered === rows.length) setImmediate(() => observed.resolve(delivered))
        if (delivered === backlog) drained.resolve()
        return result
      },
    },
  })
  try {
    dispatcher.notify()
    expect(await observed.promise).toBeLessThan(backlog)
    // Delivered by rearmed passes, before stop() runs its own final pass.
    await drained.promise
  } finally {
    await dispatcher.stop()
  }
  expect((await storage.ontology.outbox.summarize({ projectId: "project" })).pendingCount).toBe(0)
})

test("a late broker acknowledgement cannot settle a lease reclaimed after shutdown", async () => {
  jest.useFakeTimers()
  const storage = await seededStorage(1)
  const service = new DomainEventService({ projectId: "project", broker: new InMemoryBroker() })
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const completed = Promise.withResolvers<void>()
  let settlements = 0
  const restore = decorateOperationScopedMethodForTesting(
    storage.ontology.outbox,
    "markPublished",
    (run) => async (input) => {
      settlements++
      return run(input)
    }
  )
  const first = new OntologyOutboxDispatcher({
    projectId: "project",
    storage,
    shutdownTimeoutMs: 5,
    events: {
      async publishEnvelopes(rows) {
        started.resolve()
        await release.promise
        const result = await service.publishEnvelopes(rows)
        completed.resolve()
        return result
      },
    },
  })
  const next = new OntologyOutboxDispatcher({ projectId: "project", storage, events: service })
  first.notify()
  await started.promise
  try {
    const firstStop = first.stop()
    jest.advanceTimersByTime(5)
    await firstStop
    await next.drain()
    release.resolve()
    await completed.promise
    await next.stop()
    expect(settlements).toBe(1)
    const events = await service.read()
    expect(events).toHaveLength(2)
    expect(events[0]?.id).toBe(events[1]?.id)
    expect((await storage.ontology.outbox.summarize({ projectId: "project" })).pendingCount).toBe(0)
  } finally {
    release.resolve()
    await Promise.all([first.stop(), next.stop()])
    restore()
  }
})

test("publication survives a failed storage acknowledgement and replays with the same ID", async () => {
  const storage = await seededStorage(1)
  const service = new DomainEventService({ projectId: "project", broker: new InMemoryBroker() })
  let now = Date.parse("2026-01-03T00:00:00.000Z")
  const failure = new Error("synthetic acknowledgement failure")
  const restore = decorateOperationScopedMethodForTesting(
    storage.ontology.outbox,
    "markPublished",
    () => async () => {
      throw failure
    }
  )
  const first = new OntologyOutboxDispatcher({
    projectId: "project",
    storage,
    events: service,
    now: () => new Date(now),
    onError: () => {},
  })
  try {
    await expect(first.drain()).rejects.toBe(failure)
  } finally {
    restore()
    await first.stop()
  }
  now += 30_001
  const retry = new OntologyOutboxDispatcher({
    projectId: "project",
    storage,
    events: service,
    now: () => new Date(now),
  })
  try {
    await retry.drain()
    const events = await service.read()
    expect(events).toHaveLength(2)
    expect(events[0]?.id).toBe(events[1]?.id)
    expect((await storage.ontology.outbox.summarize({ projectId: "project" })).pendingCount).toBe(0)
  } finally {
    await retry.stop()
  }
})

test("shutdown finishes only its bounded final passes and leaves the rest recoverable", async () => {
  const storage = await seededStorage(20)
  const service = new DomainEventService({ projectId: "project", broker: new InMemoryBroker() })
  let delivered = 0
  const dispatcher = new OntologyOutboxDispatcher({
    projectId: "project",
    storage,
    batchSize: 1,
    maxClaimsPerDrain: 2,
    events: {
      async publishEnvelopes(rows) {
        delivered += rows.length
        return service.publishEnvelopes(rows)
      },
    },
  })
  await dispatcher.stop()
  expect(delivered).toBe(2)
  dispatcher.notify()
  await dispatcher.drain()
  expect(delivered).toBe(2)
  expect((await storage.ontology.outbox.summarize({ projectId: "project" })).pendingCount).toBe(18)
})

for (const operation of ["claim", "markPublished", "reschedule"] as const) {
  // Regression proof: restore the old bounded stop, which forgets outstanding storage work.
  test(`outbox stop waits for an in-flight ${operation} to settle`, async () => {
    jest.useFakeTimers()
    const storage = await seededStorage(1)
    const started = Promise.withResolvers<void>()
    const released = Promise.withResolvers<void>()
    const hold = async () => {
      started.resolve()
      await released.promise
    }
    const restore = holdOperation(storage.ontology.outbox, operation, hold)
    const broker = new InMemoryBroker()
    if (operation === "reschedule")
      spyOn(broker, "append").mockRejectedValue(new Error("synthetic broker failure"))
    const dispatcher = new OntologyOutboxDispatcher({
      projectId: "project",
      storage,
      events: new DomainEventService({ projectId: "project", broker }),
      shutdownTimeoutMs: 5,
    })
    let stopped = false
    const draining = dispatcher.drain()
    await started.promise
    const stopping = dispatcher.stop().then(() => {
      stopped = true
    })
    try {
      // The 5ms broker grace period expires; the outstanding storage call still holds stop open.
      jest.advanceTimersByTime(5)
      await flush()
      expect(stopped).toBe(false)
    } finally {
      released.resolve()
      await Promise.all([draining, stopping])
      restore()
    }
  })
}

function holdOperation(
  outbox: OntologyOutboxStorage,
  operation: "claim" | "markPublished" | "reschedule",
  hold: () => Promise<void>
) {
  if (operation === "claim") {
    return decorateOperationScopedMethodForTesting(outbox, "claim", (run) => async (input) => {
      await hold()
      return run(input)
    })
  }
  if (operation === "markPublished") {
    return decorateOperationScopedMethodForTesting(
      outbox,
      "markPublished",
      (run) => async (input) => {
        await hold()
        return run(input)
      }
    )
  }
  return decorateOperationScopedMethodForTesting(outbox, "reschedule", (run) => async (input) => {
    await hold()
    return run(input)
  })
}

async function seededStorage(count: number): Promise<InMemoryStorage> {
  const storage = new InMemoryStorage()
  const { materializer } = createMaterializerFixture({ storage })
  await materializer.edits.commit(
    atomic(
      "outbox-lifecycle",
      Array.from({ length: count }, (_, i) => ({
        id: `create-${i}`,
        kind: "object.create" as const,
        ref: { objectTypeId: "Device", primaryId: String(i) },
        properties: { name: `synthetic-${i}` },
      }))
    )
  )
  return storage
}
