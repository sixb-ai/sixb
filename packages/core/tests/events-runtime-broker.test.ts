import { describe, expect, test } from "bun:test"
import {
  EVENTS_STREAM,
  EventsError,
  EventsRuntime,
  InMemoryBroker,
  type StoredDomainEvent,
} from "../src"

function objectUpserted(primaryId: string) {
  return {
    type: "object.upserted" as const,
    payload: {
      objectTypeId: "Room",
      primaryId,
      properties: { name: primaryId },
    },
  }
}

function telemetryAppended(objectId: string) {
  return {
    type: "telemetry.appended" as const,
    payload: {
      objectTypeId: "Room",
      objectId,
      propertyId: "temperature",
      value: 72,
      at: "2026-05-20T10:00:00.000Z",
    },
  }
}

describe("EventsRuntime broker backing", () => {
  test("appends domain events through a broker stream", async () => {
    const broker = new RecordingBroker()
    const runtime = new EventsRuntime({ projectId: "project-a", broker })

    const [event] = await runtime.append({
      actor: { type: "system", id: "tests" },
      correlationId: "corr-1",
      causationId: "cause-1",
      events: [
        {
          ...objectUpserted("room-1"),
          metadata: { source: "unit-test" },
          idempotencyKey: "object.upserted:room-1",
        },
      ],
    })

    expect(event).toMatchObject({
      cursor: "1",
      projectId: "project-a",
      type: "object.upserted",
      topic: "objects",
      partitionKey: "Room:room-1",
      actor: { type: "system", id: "tests" },
      correlationId: "corr-1",
      causationId: "cause-1",
      metadata: { source: "unit-test" },
      idempotencyKey: "object.upserted:room-1",
    })

    const { records } = await broker.read({
      projectId: "project-a",
      streamId: EVENTS_STREAM.id,
    })
    const [record] = records
    expect(record).toMatchObject({
      streamId: "__events",
      cursor: "1",
      name: "object.upserted",
      key: "Room:room-1",
    })
    expect(record?.payload).toMatchObject({
      id: event?.id,
      type: "object.upserted",
      topic: "objects",
      partitionKey: "Room:room-1",
    })
    expect(record?.payload).not.toHaveProperty("cursor")
    expect(broker.appended[0]?.records[0]?.idempotencyKey).toBe("object.upserted:room-1")

    const [readBack] = await runtime.read()
    expect(readBack).toMatchObject({
      cursor: event?.cursor,
      id: event?.id,
      projectId: "project-a",
      type: "object.upserted",
      topic: "objects",
      actor: { type: "system", id: "tests" },
      correlationId: "corr-1",
      causationId: "cause-1",
      metadata: { source: "unit-test" },
      idempotencyKey: "object.upserted:room-1",
    })
  })

  test("reads with cursor and filter semantics", async () => {
    const runtime = new EventsRuntime({ projectId: "project-a", broker: new InMemoryBroker() })
    await runtime.append({
      events: [objectUpserted("room-1"), telemetryAppended("room-1"), objectUpserted("room-2")],
    })

    const first = (await runtime.read({ limit: 1 }))[0]
    const afterFirst = await runtime.read({ afterCursor: first?.cursor })
    expect(afterFirst.map((event) => event.cursor)).toEqual(["2", "3"])

    const objects = await runtime.read({ topics: ["objects"] })
    expect(objects.map((event) => event.type)).toEqual(["object.upserted", "object.upserted"])

    const telemetry = await runtime.read({ types: ["telemetry.appended"] })
    expect(telemetry.map((event) => event.type)).toEqual(["telemetry.appended"])

    const impossible = await runtime.read({
      topics: ["telemetry"],
      types: ["object.upserted"],
    })
    expect(impossible).toEqual([])

    const limited = await runtime.read({ topics: ["objects"], limit: 1 })
    expect(limited.map(primaryIds)).toEqual(["room-1"])
  })

  test("surfaces retained range errors for explicit afterCursor reads", async () => {
    const runtime = new EventsRuntime({
      projectId: "project-a",
      broker: new InMemoryBroker(),
      stream: { id: "__events", retention: { maxRecords: 2 } },
    })
    await runtime.append({
      events: [
        objectUpserted("room-1"),
        objectUpserted("room-2"),
        objectUpserted("room-3"),
        objectUpserted("room-4"),
      ],
    })

    await expect(runtime.read({ afterCursor: "1" })).rejects.toThrow("outside the retained range")
  })

  test("isolates projects", async () => {
    const broker = new InMemoryBroker()
    const projectA = new EventsRuntime({ projectId: "project-a", broker })
    const projectB = new EventsRuntime({ projectId: "project-b", broker })

    await projectA.append({ events: [objectUpserted("a")] })
    await projectB.append({ events: [objectUpserted("b")] })

    expect((await projectA.read()).map(primaryIds)).toEqual(["a"])
    expect((await projectB.read()).map(primaryIds)).toEqual(["b"])
  })

  test("subscribes to live events with type filters", async () => {
    const runtime = new EventsRuntime({ projectId: "project-a", broker: new InMemoryBroker() })
    const received: string[] = []

    await runtime.subscribe({ types: ["telemetry.appended"] }, (batch) => {
      received.push(...batch.map((event) => event.type))
    })

    await runtime.append({
      events: [objectUpserted("room-1"), telemetryAppended("room-1")],
    })

    expect(received).toEqual(["telemetry.appended"])
  })

  test("preserves fire-and-forget subscriber error behavior", async () => {
    const runtime = new EventsRuntime({ projectId: "project-a", broker: new InMemoryBroker() })
    const received: string[] = []

    await runtime.subscribe({}, () => {
      throw new Error("handler failed")
    })
    await runtime.subscribe({}, (batch) => {
      received.push(...batch.map((event) => event.type))
    })

    await expect(runtime.append({ events: [objectUpserted("room-1")] })).resolves.toHaveLength(1)
    expect(received).toEqual(["object.upserted"])
  })

  test("returns empty append batches", async () => {
    const broker = new InMemoryBroker()
    const runtime = new EventsRuntime({ projectId: "project-a", broker })

    expect(await runtime.append({ events: [] })).toEqual([])
    await broker.ensureStream({ projectId: "project-a", stream: EVENTS_STREAM })
    expect(
      (await broker.read({ projectId: "project-a", streamId: EVENTS_STREAM.id })).records
    ).toEqual([])
  })

  test("rejects malformed broker records", async () => {
    const broker = new InMemoryBroker()
    const runtime = new EventsRuntime({ projectId: "project-a", broker })

    await broker.ensureStream({ projectId: "project-a", stream: EVENTS_STREAM })
    await broker.append({
      projectId: "project-a",
      streamId: EVENTS_STREAM.id,
      records: [{ name: "object.upserted", payload: { type: "unknown.event" } }],
    })

    await expect(runtime.read()).rejects.toBeInstanceOf(EventsError)
  })

  test("rejects domain events that cannot be stored as broker JSON", async () => {
    const runtime = new EventsRuntime({ projectId: "project-a", broker: new InMemoryBroker() })

    await expect(
      runtime.append({
        events: [
          {
            type: "object.upserted",
            payload: {
              objectTypeId: "Room",
              primaryId: "room-1",
              properties: {
                observedAt: new Date("2026-01-01T00:00:00.000Z"),
              },
            },
          },
        ],
      })
    ).rejects.toThrow("cannot be stored in broker")
  })
})

function primaryIds(event: StoredDomainEvent): string | undefined {
  return event.type === "object.upserted" ? event.payload.primaryId : undefined
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
