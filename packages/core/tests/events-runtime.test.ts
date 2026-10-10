import { describe, expect, test } from "bun:test"
import { InMemoryBroker } from "../src"
import { DomainEventService, EVENTS_STREAM, type StoredDomainEvent } from "../src/events"

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

describe("DomainEventService", () => {
  test("appends domain events through a project-scoped broker stream", async () => {
    const broker = new RecordingBroker()
    const events = new DomainEventService({ projectId: "project-a", broker })

    const [event] = await events.append({
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
    expect(broker.appended[0]?.projectId).toBe("project-a")
    expect(broker.appended[0]?.records[0]?.idempotencyKey).toBe("sync.run.started:run-1")
  })

  test("reads with Events cursor and filter semantics without a projectId input", async () => {
    const events = new DomainEventService({ projectId: "project-a", broker: new InMemoryBroker() })
    await events.append({
      events: [syncRunStarted("run-1"), scheduleTriggered("daily"), syncRunStarted("run-2")],
    })

    const first = (await events.read({ limit: 1 }))[0]
    const afterFirst = await events.read({ afterCursor: first?.cursor })
    expect(afterFirst.map((event) => event.cursor)).toEqual(["2", "3"])

    const syncs = await events.read({ topics: ["syncs"] })
    expect(syncs.map((event) => event.type)).toEqual(["sync.run.started", "sync.run.started"])

    const schedules = await events.read({ types: ["schedule.triggered"] })
    expect(schedules.map((event) => event.type)).toEqual(["schedule.triggered"])

    const impossible = await events.read({
      topics: ["schedules"],
      types: ["sync.run.started"],
    })
    expect(impossible).toEqual([])

    const limited = await events.read({ topics: ["syncs"], limit: 1 })
    expect(limited.map(runIds)).toEqual(["run-1"])
  })

  test("returns the latest event cursor without reading retained events", async () => {
    const broker = new LatestCursorRecordingBroker()
    const events = new DomainEventService({ projectId: "project-a", broker })

    expect(await events.latestCursor()).toBeUndefined()
    const appended = await events.append({
      events: [syncRunStarted("run-1"), syncRunStarted("run-2")],
    })

    expect(await events.latestCursor()).toBe(appended.at(-1)?.cursor)
    expect(broker.latestCursorCalls).toBe(2)
    expect(broker.readCalls).toBe(0)
  })

  test("isolates projects on a shared broker", async () => {
    const broker = new InMemoryBroker()
    const projectAEvents = new DomainEventService({ projectId: "project-a", broker })
    const projectBEvents = new DomainEventService({ projectId: "project-b", broker })

    await projectAEvents.append({ events: [syncRunStarted("a")] })
    await projectBEvents.append({ events: [syncRunStarted("b")] })

    expect((await projectAEvents.read()).map(runIds)).toEqual(["a"])
    expect((await projectBEvents.read()).map(runIds)).toEqual(["b"])
  })

  test("subscribes to live events with type filters", async () => {
    const events = new DomainEventService({ projectId: "project-a", broker: new InMemoryBroker() })
    const received: string[] = []

    await events.subscribe({ types: ["schedule.triggered"] }, (batch) => {
      received.push(...batch.map((event) => event.type))
    })

    await events.append({
      events: [syncRunStarted("run-1"), scheduleTriggered("daily")],
    })

    expect(received).toEqual(["schedule.triggered"])
  })

  test("can subscribe from the earliest retained event", async () => {
    const events = new DomainEventService({ projectId: "project-a", broker: new InMemoryBroker() })
    await events.append({ events: [syncRunStarted("run-1")] })

    const received: string[] = []
    const unsubscribe = await events.subscribe({ from: "earliest" }, (batch) => {
      received.push(...batch.map(runIds).filter((id): id is string => id !== undefined))
    })

    expect(received).toEqual(["run-1"])
    unsubscribe()
  })

  test("returns empty append batches", async () => {
    const broker = new InMemoryBroker()
    const events = new DomainEventService({ projectId: "project-a", broker })

    expect(await events.append({ events: [] })).toEqual([])
    await broker.ensureStream({ projectId: "project-a", stream: EVENTS_STREAM })
    expect(
      (await broker.read({ projectId: "project-a", streamId: EVENTS_STREAM.id })).records
    ).toEqual([])
  })
})

function runIds(event: StoredDomainEvent): string | undefined {
  return event.type === "sync.run.started" ? event.payload.runId : undefined
}

class LatestCursorRecordingBroker extends InMemoryBroker {
  latestCursorCalls = 0
  readCalls = 0

  override latestCursor(
    params: Parameters<InMemoryBroker["latestCursor"]>[0]
  ): ReturnType<InMemoryBroker["latestCursor"]> {
    this.latestCursorCalls += 1
    return super.latestCursor(params)
  }

  override read(params: Parameters<InMemoryBroker["read"]>[0]): ReturnType<InMemoryBroker["read"]> {
    this.readCalls += 1
    return super.read(params)
  }
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
