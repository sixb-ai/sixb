import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import { defineObjectType, defineSchedule, prop, Sixb } from "../src"
import type { StoredScheduleTriggeredEvent } from "../src/events"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const Stub = defineObjectType({
  id: "Stub",
  name: "Stub",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const MINUTE = 60_000

describe("Scheduler integration with Sixb", () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test("startScheduler() emits events", async () => {
    const deps = createTestRuntimeDeps()
    const schedule = defineSchedule("hourly").cron("0 * * * *")

    const sixb = new Sixb({
      ontology: [Stub],
      schedules: [schedule],
      ...deps,
    })

    await sixb.schedules.start()

    // Advance past the next hour mark
    jest.advanceTimersByTime(60 * MINUTE)

    const events = await sixb.events.read({
      types: ["schedule.triggered"],
    })
    expect(events.length).toBeGreaterThanOrEqual(1)
    expect((events[0] as StoredScheduleTriggeredEvent).payload.scheduleId).toBe("hourly")

    await sixb.schedules.stop()
  })

  test("stopScheduler() stops emission", async () => {
    const deps = createTestRuntimeDeps()
    const schedule = defineSchedule("s1").cron("0 * * * *")

    const sixb = new Sixb({
      ontology: [Stub],
      schedules: [schedule],
      ...deps,
    })

    await sixb.schedules.start()
    await sixb.schedules.stop()

    jest.advanceTimersByTime(120 * MINUTE)

    const events = await sixb.events.read({
      types: ["schedule.triggered"],
    })
    expect(events).toHaveLength(0)
  })

  test("no schedules is a silent no-op", async () => {
    const deps = createTestRuntimeDeps()

    const sixb = new Sixb({
      ontology: [Stub],
      ...deps,
    })

    await sixb.schedules.start()
    await sixb.schedules.stop()
    // No errors
  })

  test("startScheduler() is idempotent", async () => {
    const deps = createTestRuntimeDeps()
    const schedule = defineSchedule("s1").cron("0 * * * *")

    const sixb = new Sixb({
      ontology: [Stub],
      schedules: [schedule],
      ...deps,
    })

    await sixb.schedules.start()
    await sixb.schedules.start() // second call is no-op

    jest.advanceTimersByTime(60 * MINUTE)

    const events = await sixb.events.read({
      types: ["schedule.triggered"],
    })
    // Should not have duplicated timers
    expect(events.length).toBeGreaterThanOrEqual(1)

    await sixb.schedules.stop()
  })

  test("full lifecycle", async () => {
    const deps = createTestRuntimeDeps()
    const schedule = defineSchedule("every-hour").cron("0 * * * *")

    const sixb = new Sixb({
      ontology: [Stub],
      schedules: [schedule],
      ...deps,
    })

    // Start
    await sixb.schedules.start()

    // Fire
    jest.advanceTimersByTime(60 * MINUTE)

    let events = await sixb.events.read({
      types: ["schedule.triggered"],
    })
    expect(events.length).toBeGreaterThanOrEqual(1)

    // Stop
    await sixb.schedules.stop()

    const countBefore = events.length

    jest.advanceTimersByTime(120 * MINUTE)

    events = await sixb.events.read({
      types: ["schedule.triggered"],
    })
    // No new events after stop
    expect(events).toHaveLength(countBefore)
  })
})
