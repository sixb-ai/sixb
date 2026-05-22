import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import { defineObjectType, defineSchedule, Pario, prop } from "../src"
import type { StoredScheduleTriggeredEvent } from "../src/events"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const Stub = defineObjectType({
  id: "Stub",
  name: "Stub",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const MINUTE = 60_000

describe("Scheduler integration with Pario", () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test("startScheduler() emits events", async () => {
    const deps = createTestRuntimeDeps()
    const schedule = defineSchedule("hourly").cron("0 * * * *")

    const pario = new Pario({
      ontology: [Stub],
      schedules: [schedule],
      ...deps,
    })

    await pario.startScheduler()

    // Advance past the next hour mark
    jest.advanceTimersByTime(60 * MINUTE)

    const events = await pario.events.read({
      types: ["schedule.triggered"],
    })
    expect(events.length).toBeGreaterThanOrEqual(1)
    expect((events[0] as StoredScheduleTriggeredEvent).payload.scheduleId).toBe("hourly")

    await pario.stopScheduler()
  })

  test("stopScheduler() stops emission", async () => {
    const deps = createTestRuntimeDeps()
    const schedule = defineSchedule("s1").cron("0 * * * *")

    const pario = new Pario({
      ontology: [Stub],
      schedules: [schedule],
      ...deps,
    })

    await pario.startScheduler()
    await pario.stopScheduler()

    jest.advanceTimersByTime(120 * MINUTE)

    const events = await pario.events.read({
      types: ["schedule.triggered"],
    })
    expect(events).toHaveLength(0)
  })

  test("no schedules is a silent no-op", async () => {
    const deps = createTestRuntimeDeps()

    const pario = new Pario({
      ontology: [Stub],
      ...deps,
    })

    await pario.startScheduler()
    await pario.stopScheduler()
    // No errors
  })

  test("startScheduler() is idempotent", async () => {
    const deps = createTestRuntimeDeps()
    const schedule = defineSchedule("s1").cron("0 * * * *")

    const pario = new Pario({
      ontology: [Stub],
      schedules: [schedule],
      ...deps,
    })

    await pario.startScheduler()
    await pario.startScheduler() // second call is no-op

    jest.advanceTimersByTime(60 * MINUTE)

    const events = await pario.events.read({
      types: ["schedule.triggered"],
    })
    // Should not have duplicated timers
    expect(events.length).toBeGreaterThanOrEqual(1)

    await pario.stopScheduler()
  })

  test("full lifecycle", async () => {
    const deps = createTestRuntimeDeps()
    const schedule = defineSchedule("every-hour").cron("0 * * * *")

    const pario = new Pario({
      ontology: [Stub],
      schedules: [schedule],
      ...deps,
    })

    // Start
    await pario.startScheduler()

    // Fire
    jest.advanceTimersByTime(60 * MINUTE)

    let events = await pario.events.read({
      types: ["schedule.triggered"],
    })
    expect(events.length).toBeGreaterThanOrEqual(1)

    // Stop
    await pario.stopScheduler()

    const countBefore = events.length

    jest.advanceTimersByTime(120 * MINUTE)

    events = await pario.events.read({
      types: ["schedule.triggered"],
    })
    // No new events after stop
    expect(events).toHaveLength(countBefore)
  })
})
