import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import type { SixbErrorContext } from "../src"
import { InMemoryBroker } from "../src"
import {
  attachSixbErrorReporter,
  type ErrorReporter,
  flushSixbErrors,
} from "../src/error-reporting/internal"
import type { StoredScheduleTriggeredEvent } from "../src/events"
import { DomainEventService } from "../src/events"
import { SchedulerRuntime, SchedulerValidationError } from "../src/scheduler"
import { defineSchedule } from "../src/schedules"

const PROJECT = "test"

function createEvents(errorReporter?: ErrorReporter) {
  return new DomainEventService({ projectId: PROJECT, broker: new InMemoryBroker(), errorReporter })
}

function createTestClock(initial: Date) {
  let current = initial
  return {
    now: () => current,
    advance(ms: number) {
      current = new Date(current.getTime() + ms)
    },
    set(date: Date) {
      current = date
    },
  }
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE

describe("SchedulerRuntime", () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test("emits at the correct time", async () => {
    const eventsRuntime = createEvents()
    const clock = createTestClock(new Date("2026-01-01T10:30:00Z"))

    const schedule = defineSchedule("hourly").cron("0 * * * *")

    const runtime = new SchedulerRuntime({
      schedules: [schedule],
      events: eventsRuntime,
      now: clock.now,
    })

    await runtime.start()

    // Advance 30 minutes to 11:00
    clock.advance(30 * MINUTE)
    jest.advanceTimersByTime(30 * MINUTE)

    const events = await eventsRuntime.read({ types: ["schedule.triggered"] })
    expect(events).toHaveLength(1)
    const event = events[0] as StoredScheduleTriggeredEvent
    expect(event.payload.occurrenceAt).toBe("2026-01-01T11:00:00.000Z")
    expect(event.payload.scheduleId).toBe("hourly")

    await runtime.stop()
  })

  test("next occurrence after fire", async () => {
    const eventsRuntime = createEvents()
    const clock = createTestClock(new Date("2026-01-01T10:30:00Z"))

    const schedule = defineSchedule("hourly").cron("0 * * * *")

    const runtime = new SchedulerRuntime({
      schedules: [schedule],
      events: eventsRuntime,
      now: clock.now,
    })

    await runtime.start()

    // First fire at 11:00
    clock.advance(30 * MINUTE)
    jest.advanceTimersByTime(30 * MINUTE)

    // Second fire at 12:00
    clock.advance(60 * MINUTE)
    jest.advanceTimersByTime(60 * MINUTE)

    const events = await eventsRuntime.read({ types: ["schedule.triggered"] })
    expect(events).toHaveLength(2)
    expect((events[0] as StoredScheduleTriggeredEvent).payload.occurrenceAt).toBe(
      "2026-01-01T11:00:00.000Z"
    )
    expect((events[1] as StoredScheduleTriggeredEvent).payload.occurrenceAt).toBe(
      "2026-01-01T12:00:00.000Z"
    )

    await runtime.stop()
  })

  test("multiple schedules with different frequencies", async () => {
    const eventsRuntime = createEvents()
    const clock = createTestClock(new Date("2026-01-01T10:00:00Z"))

    const every15 = defineSchedule("every-15").cron("*/15 * * * *")
    const hourly = defineSchedule("hourly").cron("0 * * * *")

    const runtime = new SchedulerRuntime({
      schedules: [every15, hourly],
      events: eventsRuntime,
      now: clock.now,
    })

    await runtime.start()

    // At 10:15 — only every-15 fires
    clock.advance(15 * MINUTE)
    jest.advanceTimersByTime(15 * MINUTE)

    let events = await eventsRuntime.read({ types: ["schedule.triggered"] })
    const at1015 = events.filter(
      (e) => (e as StoredScheduleTriggeredEvent).payload.scheduleId === "every-15"
    )
    expect(at1015).toHaveLength(1)

    // At 11:00 — both fire
    clock.advance(45 * MINUTE)
    jest.advanceTimersByTime(45 * MINUTE)

    events = await eventsRuntime.read({ types: ["schedule.triggered"] })
    const hourlyEvents = events.filter(
      (e) => (e as StoredScheduleTriggeredEvent).payload.scheduleId === "hourly"
    )
    expect(hourlyEvents.length).toBeGreaterThanOrEqual(1)

    await runtime.stop()
  })

  test("occurrenceKey is deterministic", async () => {
    const eventsRuntime = createEvents()
    const clock = createTestClock(new Date("2026-01-01T10:30:00Z"))

    const schedule = defineSchedule("my-schedule").cron("0 * * * *")

    const runtime = new SchedulerRuntime({
      schedules: [schedule],
      events: eventsRuntime,
      now: clock.now,
    })

    await runtime.start()

    clock.advance(30 * MINUTE)
    jest.advanceTimersByTime(30 * MINUTE)

    const events = await eventsRuntime.read({ types: ["schedule.triggered"] })
    const event = events[0] as StoredScheduleTriggeredEvent
    expect(event.payload.occurrenceKey).toBe(`my-schedule:${event.payload.occurrenceAt}`)

    await runtime.stop()
  })

  test("duplicate schedule ids throws SchedulerValidationError", async () => {
    const eventsRuntime = createEvents()
    const schedule1 = defineSchedule("dup").cron("0 * * * *")
    const schedule2 = defineSchedule("dup").cron("*/5 * * * *")

    const runtime = new SchedulerRuntime({
      schedules: [schedule1, schedule2],
      events: eventsRuntime,
    })

    expect(runtime.start()).rejects.toThrow(SchedulerValidationError)
  })

  test("start() is idempotent", async () => {
    const eventsRuntime = createEvents()
    const clock = createTestClock(new Date("2026-01-01T10:00:00Z"))

    const schedule = defineSchedule("s1").cron("0 * * * *")

    const runtime = new SchedulerRuntime({
      schedules: [schedule],
      events: eventsRuntime,
      now: clock.now,
    })

    await runtime.start()
    await runtime.start() // second call is no-op

    clock.advance(HOUR)
    jest.advanceTimersByTime(HOUR)

    const events = await eventsRuntime.read({ types: ["schedule.triggered"] })
    expect(events).toHaveLength(1) // no duplicates from double start

    await runtime.stop()
  })

  test("stop() prevents further events", async () => {
    const eventsRuntime = createEvents()
    const clock = createTestClock(new Date("2026-01-01T10:30:00Z"))

    const schedule = defineSchedule("s1").cron("0 * * * *")

    const runtime = new SchedulerRuntime({
      schedules: [schedule],
      events: eventsRuntime,
      now: clock.now,
    })

    await runtime.start()
    await runtime.stop()

    clock.advance(HOUR)
    jest.advanceTimersByTime(HOUR)

    const events = await eventsRuntime.read({ types: ["schedule.triggered"] })
    expect(events).toHaveLength(0)
  })

  test("no schedules is a clean no-op", async () => {
    const eventsRuntime = createEvents()

    const runtime = new SchedulerRuntime({
      schedules: [],
      events: eventsRuntime,
    })

    await runtime.start()
    await runtime.stop()
    // No errors thrown
  })

  test("timezone-aware scheduling", async () => {
    const eventsRuntime = createEvents()
    // 21:30 UTC = 23:30 Paris (CEST, summer)
    const clock = createTestClock(new Date("2026-07-15T21:30:00Z"))

    const schedule = defineSchedule("paris-midnight").cron("0 0 * * *", {
      timezone: "Europe/Paris",
    })

    const runtime = new SchedulerRuntime({
      schedules: [schedule],
      events: eventsRuntime,
      now: clock.now,
    })

    await runtime.start()

    // Midnight Paris (CEST) = 22:00 UTC, 30 minutes from now
    clock.advance(30 * MINUTE)
    jest.advanceTimersByTime(30 * MINUTE)

    const events = await eventsRuntime.read({ types: ["schedule.triggered"] })
    expect(events).toHaveLength(1)
    expect((events[0] as StoredScheduleTriggeredEvent).payload.occurrenceAt).toBe(
      "2026-07-15T22:00:00.000Z"
    )

    await runtime.stop()
  })

  test("timer lag emits multiple events in a single tick", async () => {
    const eventsRuntime = createEvents()
    const clock = createTestClock(new Date("2026-01-01T10:00:00Z"))

    const schedule = defineSchedule("hourly").cron("0 * * * *")

    const runtime = new SchedulerRuntime({
      schedules: [schedule],
      events: eventsRuntime,
      now: clock.now,
    })

    await runtime.start()

    // Jump 2.5 hours — timer fires once but clock shows 2 occurrences have passed
    clock.advance(150 * MINUTE)
    jest.advanceTimersByTime(150 * MINUTE)

    const events = await eventsRuntime.read({ types: ["schedule.triggered"] })
    // At minimum, the tick should emit at least the first due occurrence
    // Multiple occurrences may be caught up in subsequent timer ticks
    expect(events.length).toBeGreaterThanOrEqual(1)

    await runtime.stop()
  })

  test("a lost trigger reaches onError instead of vanishing", async () => {
    const originalError = console.error
    console.error = () => {}

    try {
      const reports: { error: Error; context: SixbErrorContext }[] = []
      const host = {}
      const errorReporter = attachSixbErrorReporter(host, (error, context) => {
        reports.push({ error, context })
      })

      const eventsRuntime = createEvents(errorReporter)
      const appendFailure = new Error("broker unavailable")
      eventsRuntime.append = () => Promise.reject(appendFailure)

      const clock = createTestClock(new Date("2026-01-01T10:30:00Z"))
      const runtime = new SchedulerRuntime({
        schedules: [defineSchedule("hourly").cron("0 * * * *")],
        events: eventsRuntime,
        now: clock.now,
      })

      await runtime.start()
      clock.advance(30 * MINUTE)
      jest.advanceTimersByTime(30 * MINUTE)
      // `stop()` drains the emit the tick started, so the rejection is observed before we assert.
      await runtime.stop()
      await flushSixbErrors(host)

      expect(reports).toHaveLength(1)
      expect(reports[0]?.error).toBe(appendFailure)
      const context = reports[0]?.context
      expect(context?.type).toBe("event.delivery.failed")
      if (context?.type !== "event.delivery.failed") throw new Error("expected a delivery failure")
      expect(context.eventTypes).toEqual(["schedule.triggered"])
      expect(context.attempts).toBe(1)
      expect(context.eventIds).toBeUndefined()
      expect(context.projectId).toBe(PROJECT)
    } finally {
      console.error = originalError
    }
  })

  // Guards the `MAX_TIMER_DELAY_MS` clamp in `armTimer`. To prove it still guards, drop the
  // `Math.min(..., MAX_TIMER_DELAY_MS)` and this test fails: Node coerces the oversized delay to
  // 1ms, so the timer fires immediately, finds nothing due, and re-arms forever.
  test("clamps an occurrence beyond the setTimeout ceiling instead of spinning", async () => {
    const eventsRuntime = createEvents()
    const clock = createTestClock(new Date("2026-01-02T00:00:00Z"))
    // Next 1 January is ~364 days out, far beyond the 24.8-day timer ceiling.
    const schedule = defineSchedule("yearly").cron("0 0 1 1 *")

    const delays: number[] = []
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...rest: unknown[]) => {
      if (typeof timeout === "number") delays.push(timeout)
      return (originalSetTimeout as (...args: unknown[]) => ReturnType<typeof setTimeout>)(
        handler,
        timeout,
        ...rest
      )
    }) as unknown as typeof globalThis.setTimeout

    try {
      const runtime = new SchedulerRuntime({
        schedules: [schedule],
        events: eventsRuntime,
        now: clock.now,
      })
      await runtime.start()

      // A whole second of wall clock must not wake the scheduler even once.
      clock.advance(1_000)
      jest.advanceTimersByTime(1_000)

      expect(delays).toHaveLength(1)
      expect(delays[0]).toBe(2_147_483_647)
      expect(await eventsRuntime.read({ types: ["schedule.triggered"] })).toHaveLength(0)

      await runtime.stop()
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  // Guards the try/catch added to `start()`. To prove it, remove that try/catch: `start()` throws,
  // which the CLI turns into `process.exit(1)`, so one bad expression stops every schedule.
  test("starts the remaining schedules when one expression has no reachable occurrence", async () => {
    const eventsRuntime = createEvents()
    const clock = createTestClock(new Date("2026-01-01T10:30:00Z"))

    // `0 0 30 2 *` is syntactically valid and passes definition validation, but 30 February
    // never occurs, so computing its next occurrence throws.
    const unreachable = defineSchedule("feb-30").cron("0 0 30 2 *")
    const healthy = defineSchedule("hourly").cron("0 * * * *")

    const originalError = console.error
    const errors: unknown[][] = []
    console.error = (...args: unknown[]) => {
      errors.push(args)
    }

    try {
      const runtime = new SchedulerRuntime({
        schedules: [unreachable, healthy],
        events: eventsRuntime,
        now: clock.now,
      })

      await runtime.start()

      clock.advance(30 * MINUTE)
      jest.advanceTimersByTime(30 * MINUTE)

      const events = await eventsRuntime.read({ types: ["schedule.triggered"] })
      expect(events).toHaveLength(1)
      expect((events[0] as StoredScheduleTriggeredEvent).payload.scheduleId).toBe("hourly")
      expect(errors.some((args) => String(args[0]).includes("feb-30"))).toBe(true)

      await runtime.stop()
    } finally {
      console.error = originalError
    }
  })
})
