import { describe, expect, test } from "bun:test"
import { InMemoryBroker } from "../src"
import {
  DomainEventService,
  EVENTS_STREAM,
  EventsError,
  type StoredDomainEvent,
} from "../src/events"

function syncRunStarted(runId: string) {
  return {
    type: "sync.run.started" as const,
    payload: {
      syncId: "test-sync",
      runId,
      startedAt: "2026-05-20T10:00:00.000Z",
    },
  }
}

function scheduleTriggered(scheduleId: string) {
  return {
    type: "schedule.triggered" as const,
    payload: {
      scheduleId,
      occurrenceAt: "2026-05-20T10:00:00.000Z",
      triggeredAt: "2026-05-20T10:00:00.000Z",
      occurrenceKey: scheduleId,
    },
  }
}

describe("DomainEventService broker backing", () => {
  test("appends domain events through a broker stream", async () => {
    const broker = new RecordingBroker()
    const runtime = new DomainEventService({ projectId: "project-a", broker })

    const [event] = await runtime.append({
      correlationId: "corr-1",
      causationId: "cause-1",
      events: [
        {
          ...syncRunStarted("run-1"),
          metadata: { source: "unit-test" },
          idempotencyKey: "sync.run.started:run-1",
        },
      ],
    })

    expect(event).toMatchObject({
      cursor: "1",
      projectId: "project-a",
      type: "sync.run.started",
      topic: "syncs",
      partitionKey: "test-sync:run-1",
      correlationId: "corr-1",
      causationId: "cause-1",
      metadata: { source: "unit-test" },
      idempotencyKey: "sync.run.started:run-1",
    })

    const { records } = await broker.read({
      projectId: "project-a",
      streamId: EVENTS_STREAM.id,
    })
    const [record] = records
    expect(record).toMatchObject({
      streamId: "__events",
      cursor: "1",
      name: "sync.run.started",
      key: "test-sync:run-1",
    })
    expect(record?.payload).toMatchObject({
      id: event?.id,
      type: "sync.run.started",
      topic: "syncs",
      partitionKey: "test-sync:run-1",
    })
    expect(record?.payload).not.toHaveProperty("cursor")
    expect(broker.appended[0]?.records[0]?.idempotencyKey).toBe("sync.run.started:run-1")

    const [readBack] = await runtime.read()
    expect(readBack).toMatchObject({
      cursor: event?.cursor,
      id: event?.id,
      projectId: "project-a",
      type: "sync.run.started",
      topic: "syncs",
      correlationId: "corr-1",
      causationId: "cause-1",
      metadata: { source: "unit-test" },
      idempotencyKey: "sync.run.started:run-1",
    })
  })

  test("reads with cursor and filter semantics", async () => {
    const runtime = new DomainEventService({ projectId: "project-a", broker: new InMemoryBroker() })
    await runtime.append({
      events: [syncRunStarted("run-1"), scheduleTriggered("daily"), syncRunStarted("run-2")],
    })

    const first = (await runtime.read({ limit: 1 }))[0]
    const afterFirst = await runtime.read({ afterCursor: first?.cursor })
    expect(afterFirst.map((event) => event.cursor)).toEqual(["2", "3"])

    const syncs = await runtime.read({ topics: ["syncs"] })
    expect(syncs.map((event) => event.type)).toEqual(["sync.run.started", "sync.run.started"])

    const schedules = await runtime.read({ types: ["schedule.triggered"] })
    expect(schedules.map((event) => event.type)).toEqual(["schedule.triggered"])

    const impossible = await runtime.read({
      topics: ["schedules"],
      types: ["sync.run.started"],
    })
    expect(impossible).toEqual([])

    const limited = await runtime.read({ topics: ["syncs"], limit: 1 })
    expect(limited.map(runIds)).toEqual(["run-1"])
  })

  test("surfaces retained range errors for explicit afterCursor reads", async () => {
    const runtime = new DomainEventService({
      projectId: "project-a",
      broker: new InMemoryBroker(),
      stream: { id: "__events", retention: { maxRecords: 2 } },
    })
    await runtime.append({
      events: [
        syncRunStarted("run-1"),
        syncRunStarted("run-2"),
        syncRunStarted("run-3"),
        syncRunStarted("run-4"),
      ],
    })

    await expect(runtime.read({ afterCursor: "1" })).rejects.toThrow("outside the retained range")
  })

  test("isolates projects", async () => {
    const broker = new InMemoryBroker()
    const projectA = new DomainEventService({ projectId: "project-a", broker })
    const projectB = new DomainEventService({ projectId: "project-b", broker })

    await projectA.append({ events: [syncRunStarted("a")] })
    await projectB.append({ events: [syncRunStarted("b")] })

    expect((await projectA.read()).map(runIds)).toEqual(["a"])
    expect((await projectB.read()).map(runIds)).toEqual(["b"])
  })

  test("subscribes to live events with type filters", async () => {
    const runtime = new DomainEventService({ projectId: "project-a", broker: new InMemoryBroker() })
    const received: string[] = []

    await runtime.subscribe({ types: ["schedule.triggered"] }, (batch) => {
      received.push(...batch.map((event) => event.type))
    })

    await runtime.append({
      events: [syncRunStarted("run-1"), scheduleTriggered("daily")],
    })

    expect(received).toEqual(["schedule.triggered"])
  })

  test("preserves fire-and-forget subscriber error behavior", async () => {
    const runtime = new DomainEventService({ projectId: "project-a", broker: new InMemoryBroker() })
    const received: string[] = []

    await runtime.subscribe({}, () => {
      throw new Error("handler failed")
    })
    await runtime.subscribe({}, (batch) => {
      received.push(...batch.map((event) => event.type))
    })

    await expect(runtime.append({ events: [syncRunStarted("run-1")] })).resolves.toHaveLength(1)
    expect(received).toEqual(["sync.run.started"])
  })

  test("skips retained event types that are no longer part of the domain contract", async () => {
    const broker = new InMemoryBroker()
    const runtime = new DomainEventService({ projectId: "project-a", broker })

    await broker.ensureStream({ projectId: "project-a", stream: EVENTS_STREAM })
    await broker.append({
      projectId: "project-a",
      streamId: EVENTS_STREAM.id,
      records: [
        { name: "object.upserted", payload: { type: "object.upserted" } },
        // An Action event as runtimes wrote them before Actions stopped emitting events.
        {
          name: "action.completed",
          key: "approve-invoice",
          payload: {
            id: "event-1",
            schemaVersion: 1,
            projectId: "project-a",
            occurredAt: "2026-05-20T10:00:00.000Z",
            type: "action.completed",
            topic: "actions",
            partitionKey: "approve-invoice",
            payload: {
              actionId: "approve-invoice",
              runId: "action-run-1",
              subject: { kind: "none" },
              finishedAt: "2026-05-20T10:00:00.000Z",
            },
          },
        },
      ],
    })
    await runtime.append({ events: [syncRunStarted("run-1")] })

    expect((await runtime.read()).map((event) => event.type)).toEqual(["sync.run.started"])

    const received: string[] = []
    const unsubscribe = await runtime.subscribe({ from: "earliest" }, (batch) => {
      received.push(...batch.map((event) => event.type))
    })
    expect(received).toEqual(["sync.run.started"])
    unsubscribe()
  })

  test("returns empty append batches", async () => {
    const broker = new InMemoryBroker()
    const runtime = new DomainEventService({ projectId: "project-a", broker })

    expect(await runtime.append({ events: [] })).toEqual([])
    await broker.ensureStream({ projectId: "project-a", stream: EVENTS_STREAM })
    expect(
      (await broker.read({ projectId: "project-a", streamId: EVENTS_STREAM.id })).records
    ).toEqual([])
  })

  test("rejects malformed broker records", async () => {
    const broker = new InMemoryBroker()
    const runtime = new DomainEventService({ projectId: "project-a", broker })

    await broker.ensureStream({ projectId: "project-a", stream: EVENTS_STREAM })
    await broker.append({
      projectId: "project-a",
      streamId: EVENTS_STREAM.id,
      records: [{ name: "object.created", payload: { type: "unknown.event" } }],
    })

    await expect(runtime.read()).rejects.toBeInstanceOf(EventsError)
  })

  test("rejects directly authored ontology facts", async () => {
    const runtime = new DomainEventService({ projectId: "project-a", broker: new InMemoryBroker() })

    await expect(
      runtime.append({
        events: [
          {
            type: "object.created",
            payload: {
              objectTypeId: "Room",
              primaryId: "room-1",
              properties: {
                observedAt: new Date("2026-01-01T00:00:00.000Z"),
              },
              propertyChanges: {},
            },
          } as never,
        ],
      })
    ).rejects.toThrow("authoritative ontology fact")
  })

  test("rejects authorable events that cannot be stored as broker JSON", async () => {
    const runtime = new DomainEventService({ projectId: "project-a", broker: new InMemoryBroker() })

    // No authorable payload field accepts a non-JSON value, so the draft leaves its type behind to
    // reach the runtime check.
    await expect(
      runtime.append({
        events: [
          {
            ...syncRunStarted("run-1"),
            payload: {
              ...syncRunStarted("run-1").payload,
              startedAt: new Date("2026-01-01T00:00:00.000Z"),
            },
          } as never,
        ],
      })
    ).rejects.toThrow("cannot be stored in broker")
  })
})

function runIds(event: StoredDomainEvent): string | undefined {
  return event.type === "sync.run.started" ? event.payload.runId : undefined
}

class RecordingBroker extends InMemoryBroker {
  readonly appended: Parameters<InMemoryBroker["append"]>[0][] = []

  override append(
    params: Parameters<InMemoryBroker["append"]>[0]
  ): ReturnType<InMemoryBroker["append"]> {
    this.appended.push(params)
    return super.append(params)
  }
}
