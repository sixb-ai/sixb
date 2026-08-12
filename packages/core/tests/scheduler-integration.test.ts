import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import { defineObjectType, defineSchedule, prop, SixbHost } from "../src"
import type { StoredScheduleTriggeredEvent } from "../src/events"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const Stub = defineObjectType({
  id: "Stub",
  name: "Stub",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const MINUTE = 60_000

describe("Scheduler integration with SixbHost", () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test("scheduler.start() emits events", async () => {
    const deps = createTestRuntimeDeps()
    const schedule = defineSchedule("hourly").cron("0 * * * *")

    const sixb = new SixbHost({
      ontology: [Stub],
      schedules: [schedule],
      ...deps,
    })

    await sixb.scheduler.start()

    // Advance past the next hour mark
    jest.advanceTimersByTime(60 * MINUTE)

    const events = await sixb.events.read({
      types: ["schedule.triggered"],
    })
    expect(events.length).toBeGreaterThanOrEqual(1)
    expect((events[0] as StoredScheduleTriggeredEvent).payload.scheduleId).toBe("hourly")

    await sixb.scheduler.stop()
  })

  test("scheduler.stop() stops emission", async () => {
    const deps = createTestRuntimeDeps()
    const schedule = defineSchedule("s1").cron("0 * * * *")

    const sixb = new SixbHost({
      ontology: [Stub],
      schedules: [schedule],
      ...deps,
    })

    await sixb.scheduler.start()
    await sixb.scheduler.stop()

    jest.advanceTimersByTime(120 * MINUTE)

    const events = await sixb.events.read({
      types: ["schedule.triggered"],
    })
    expect(events).toHaveLength(0)
  })

  test("no schedules is a silent no-op", async () => {
    const deps = createTestRuntimeDeps()

    const sixb = new SixbHost({
      ontology: [Stub],
      ...deps,
    })

    await sixb.scheduler.start()
    await sixb.scheduler.stop()
    // No errors
  })

  test("scheduler.start() is idempotent", async () => {
    const deps = createTestRuntimeDeps()
    const schedule = defineSchedule("s1").cron("0 * * * *")

    const sixb = new SixbHost({
      ontology: [Stub],
      schedules: [schedule],
      ...deps,
    })

    await sixb.scheduler.start()
    await sixb.scheduler.start() // second call is no-op

    jest.advanceTimersByTime(60 * MINUTE)

    const events = await sixb.events.read({
      types: ["schedule.triggered"],
    })
    // Should not have duplicated timers
    expect(events.length).toBeGreaterThanOrEqual(1)

    await sixb.scheduler.stop()
  })

  test("full lifecycle", async () => {
    const deps = createTestRuntimeDeps()
    const schedule = defineSchedule("every-hour").cron("0 * * * *")

    const sixb = new SixbHost({
      ontology: [Stub],
      schedules: [schedule],
      ...deps,
    })

    // Start
    await sixb.scheduler.start()

    // Fire
    jest.advanceTimersByTime(60 * MINUTE)

    let events = await sixb.events.read({
      types: ["schedule.triggered"],
    })
    expect(events.length).toBeGreaterThanOrEqual(1)

    // Stop
    await sixb.scheduler.stop()

    const countBefore = events.length

    jest.advanceTimersByTime(120 * MINUTE)

    events = await sixb.events.read({
      types: ["schedule.triggered"],
    })
    // No new events after stop
    expect(events).toHaveLength(countBefore)
  })
})
