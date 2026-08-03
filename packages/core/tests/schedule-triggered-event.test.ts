import { describe, expect, test } from "bun:test"
import { InMemoryBroker } from "../src"
import type { StoredScheduleTriggeredEvent } from "../src/events"
import { EventsRuntime } from "../src/events"

function createEvents(projectId: string) {
  return new EventsRuntime({ projectId, broker: new InMemoryBroker(), host: null })
}

describe("schedule.triggered event", () => {
  const projectId = "test-project"

  test("append + read back", async () => {
    const events = createEvents(projectId)

    const stored = await events.append({
      events: [
        {
          type: "schedule.triggered",
          payload: {
            scheduleId: "nightly-sync",
            occurrenceAt: "2026-01-15T00:00:00.000Z",
            triggeredAt: "2026-01-15T00:00:00.100Z",
            occurrenceKey: "nightly-sync:2026-01-15T00:00:00.000Z",
          },
        },
      ],
    })

    expect(stored).toHaveLength(1)
    const event = stored[0] as StoredScheduleTriggeredEvent
    expect(event.type).toBe("schedule.triggered")
    expect(event.topic).toBe("schedules")
    expect(event.partitionKey).toBe("nightly-sync")
    expect(event.payload.scheduleId).toBe("nightly-sync")
    expect(event.payload.occurrenceAt).toBe("2026-01-15T00:00:00.000Z")
    expect(event.payload.triggeredAt).toBe("2026-01-15T00:00:00.100Z")
    expect(event.payload.occurrenceKey).toBe("nightly-sync:2026-01-15T00:00:00.000Z")
  })

  test("subscribe filters by types", async () => {
    const events = createEvents(projectId)
    const received: unknown[] = []

    await events.subscribe({ types: ["schedule.triggered"] }, (batch) => {
      received.push(...batch)
    })

    await events.append({
      events: [
        {
          type: "schedule.triggered",
          payload: {
            scheduleId: "s1",
            occurrenceAt: "2026-01-01T00:00:00.000Z",
            triggeredAt: "2026-01-01T00:00:00.050Z",
            occurrenceKey: "s1:2026-01-01T00:00:00.000Z",
          },
        },
      ],
    })

    expect(received).toHaveLength(1)
  })

  test("read filters by topics", async () => {
    const events = createEvents(projectId)

    await events.append({
      events: [
        {
          type: "schedule.triggered",
          payload: {
            scheduleId: "s1",
            occurrenceAt: "2026-01-01T00:00:00.000Z",
            triggeredAt: "2026-01-01T00:00:00.050Z",
            occurrenceKey: "s1:2026-01-01T00:00:00.000Z",
          },
        },
      ],
    })

    const readEvents = await events.read({ topics: ["schedules"] })
    expect(readEvents).toHaveLength(1)
    expect(readEvents[0].type).toBe("schedule.triggered")
  })

  test("partitionKey equals scheduleId", async () => {
    const events = createEvents(projectId)

    const stored = await events.append({
      events: [
        {
          type: "schedule.triggered",
          payload: {
            scheduleId: "my-schedule",
            occurrenceAt: "2026-01-01T00:00:00.000Z",
            triggeredAt: "2026-01-01T00:00:00.050Z",
            occurrenceKey: "my-schedule:2026-01-01T00:00:00.000Z",
          },
        },
      ],
    })

    expect(stored[0].partitionKey).toBe("my-schedule")
  })
})
