import { describe, expect, test } from "bun:test"
import { EVENTS_STREAM, EventsRuntime, InMemoryBroker, type StoredDomainEvent } from "../src"

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

describe("EventsRuntime", () => {
  test("appends domain events through a project-scoped broker stream", async () => {
    const broker = new RecordingBroker()
    const events = new EventsRuntime({ projectId: "project-a", broker })

    const [event] = await events.append({
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
    expect(broker.appended[0]?.projectId).toBe("project-a")
    expect(broker.appended[0]?.records[0]?.idempotencyKey).toBe("object.upserted:room-1")
  })

  test("reads with Events cursor and filter semantics without a projectId input", async () => {
    const events = new EventsRuntime({ projectId: "project-a", broker: new InMemoryBroker() })
    await events.append({
      events: [objectUpserted("room-1"), telemetryAppended("room-1"), objectUpserted("room-2")],
    })

    const first = (await events.read({ limit: 1 }))[0]
    const afterFirst = await events.read({ afterCursor: first?.cursor })
    expect(afterFirst.map((event) => event.cursor)).toEqual(["2", "3"])

    const objects = await events.read({ topics: ["objects"] })
    expect(objects.map((event) => event.type)).toEqual(["object.upserted", "object.upserted"])

    const telemetry = await events.read({ types: ["telemetry.appended"] })
    expect(telemetry.map((event) => event.type)).toEqual(["telemetry.appended"])

    const impossible = await events.read({
      topics: ["telemetry"],
      types: ["object.upserted"],
    })
    expect(impossible).toEqual([])

    const limited = await events.read({ topics: ["objects"], limit: 1 })
    expect(limited.map(primaryIds)).toEqual(["room-1"])
  })

  test("isolates projects on a shared broker", async () => {
    const broker = new InMemoryBroker()
    const projectAEvents = new EventsRuntime({ projectId: "project-a", broker })
    const projectBEvents = new EventsRuntime({ projectId: "project-b", broker })

    await projectAEvents.append({ events: [objectUpserted("a")] })
    await projectBEvents.append({ events: [objectUpserted("b")] })

    expect((await projectAEvents.read()).map(primaryIds)).toEqual(["a"])
    expect((await projectBEvents.read()).map(primaryIds)).toEqual(["b"])
  })

  test("subscribes to live events with type filters", async () => {
    const events = new EventsRuntime({ projectId: "project-a", broker: new InMemoryBroker() })
    const received: string[] = []

    await events.subscribe({ types: ["telemetry.appended"] }, (batch) => {
      received.push(...batch.map((event) => event.type))
    })

    await events.append({
      events: [objectUpserted("room-1"), telemetryAppended("room-1")],
    })

    expect(received).toEqual(["telemetry.appended"])
  })

  test("returns empty append batches", async () => {
    const broker = new InMemoryBroker()
    const events = new EventsRuntime({ projectId: "project-a", broker })

    expect(await events.append({ events: [] })).toEqual([])
    await broker.ensureStream({ projectId: "project-a", stream: EVENTS_STREAM })
    expect(await broker.read({ projectId: "project-a", streamId: EVENTS_STREAM.id })).toEqual([])
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
