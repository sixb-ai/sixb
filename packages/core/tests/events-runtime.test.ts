import { describe, expect, test } from "bun:test"
import { InMemoryBroker } from "../src"
import { EVENTS_STREAM, EventsRuntime, type StoredDomainEvent } from "../src/events"

function actionRequested(runId: string) {
  return {
    type: "action.requested" as const,
    payload: {
      actionId: "test-action",
      runId,
      subject: { kind: "none" as const },
      params: {},
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

describe("EventsRuntime", () => {
  test("appends domain events through a project-scoped broker stream", async () => {
    const broker = new RecordingBroker()
    const events = new EventsRuntime({ projectId: "project-a", broker, host: null })

    const [event] = await events.append({
      actor: { type: "system", id: "tests" },
      correlationId: "corr-1",
      causationId: "cause-1",
      events: [
        {
          ...actionRequested("run-1"),
          metadata: { source: "unit-test" },
          idempotencyKey: "action.requested:run-1",
        },
      ],
    })

    expect(event).toMatchObject({
      cursor: "1",
      projectId: "project-a",
      type: "action.requested",
      topic: "actions",
      partitionKey: "test-action",
      actor: { type: "system", id: "tests" },
      correlationId: "corr-1",
      causationId: "cause-1",
      metadata: { source: "unit-test" },
      idempotencyKey: "action.requested:run-1",
    })
    expect(broker.appended[0]?.projectId).toBe("project-a")
    expect(broker.appended[0]?.records[0]?.idempotencyKey).toBe("action.requested:run-1")
  })

  test("reads with Events cursor and filter semantics without a projectId input", async () => {
    const events = new EventsRuntime({
      projectId: "project-a",
      broker: new InMemoryBroker(),
      host: null,
    })
    await events.append({
      events: [actionRequested("run-1"), scheduleTriggered("daily"), actionRequested("run-2")],
    })

    const first = (await events.read({ limit: 1 }))[0]
    const afterFirst = await events.read({ afterCursor: first?.cursor })
    expect(afterFirst.map((event) => event.cursor)).toEqual(["2", "3"])

    const actions = await events.read({ topics: ["actions"] })
    expect(actions.map((event) => event.type)).toEqual(["action.requested", "action.requested"])

    const schedules = await events.read({ types: ["schedule.triggered"] })
    expect(schedules.map((event) => event.type)).toEqual(["schedule.triggered"])

    const impossible = await events.read({
      topics: ["schedules"],
      types: ["action.requested"],
    })
    expect(impossible).toEqual([])

    const limited = await events.read({ topics: ["actions"], limit: 1 })
    expect(limited.map(runIds)).toEqual(["run-1"])
  })

  test("returns the latest event cursor without reading retained events", async () => {
    const broker = new LatestCursorRecordingBroker()
    const events = new EventsRuntime({ projectId: "project-a", broker, host: null })

    expect(await events.latestCursor()).toBeUndefined()
    const appended = await events.append({
      events: [actionRequested("run-1"), actionRequested("run-2")],
    })

    expect(await events.latestCursor()).toBe(appended.at(-1)?.cursor)
    expect(broker.latestCursorCalls).toBe(2)
    expect(broker.readCalls).toBe(0)
  })

  test("isolates projects on a shared broker", async () => {
    const broker = new InMemoryBroker()
    const projectAEvents = new EventsRuntime({ projectId: "project-a", broker, host: null })
    const projectBEvents = new EventsRuntime({ projectId: "project-b", broker, host: null })

    await projectAEvents.append({ events: [actionRequested("a")] })
    await projectBEvents.append({ events: [actionRequested("b")] })

    expect((await projectAEvents.read()).map(runIds)).toEqual(["a"])
    expect((await projectBEvents.read()).map(runIds)).toEqual(["b"])
  })

  test("subscribes to live events with type filters", async () => {
    const events = new EventsRuntime({
      projectId: "project-a",
      broker: new InMemoryBroker(),
      host: null,
    })
    const received: string[] = []

    await events.subscribe({ types: ["schedule.triggered"] }, (batch) => {
      received.push(...batch.map((event) => event.type))
    })

    await events.append({
      events: [actionRequested("run-1"), scheduleTriggered("daily")],
    })

    expect(received).toEqual(["schedule.triggered"])
  })

  test("can subscribe from the earliest retained event", async () => {
    const events = new EventsRuntime({
      projectId: "project-a",
      broker: new InMemoryBroker(),
      host: null,
    })
    await events.append({ events: [actionRequested("run-1")] })

    const received: string[] = []
    const unsubscribe = await events.subscribe({ from: "earliest" }, (batch) => {
      received.push(...batch.map(runIds).filter((id): id is string => id !== undefined))
    })

    expect(received).toEqual(["run-1"])
    unsubscribe()
  })

  test("returns empty append batches", async () => {
    const broker = new InMemoryBroker()
    const events = new EventsRuntime({ projectId: "project-a", broker, host: null })

    expect(await events.append({ events: [] })).toEqual([])
    await broker.ensureStream({ projectId: "project-a", stream: EVENTS_STREAM })
    expect(
      (await broker.read({ projectId: "project-a", streamId: EVENTS_STREAM.id })).records
    ).toEqual([])
  })
})

function runIds(event: StoredDomainEvent): string | undefined {
  return event.type === "action.requested" ? event.payload.runId : undefined
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
