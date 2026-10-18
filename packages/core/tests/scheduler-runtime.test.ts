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

async function firedOccurrences(events: DomainEventService): Promise<string[]> {
  return (await events.read({ types: ["schedule.triggered"] })).map((event) => {
    const { scheduleId, occurrenceAt } = (event as StoredScheduleTriggeredEvent).payload
    return `${scheduleId}@${occurrenceAt}`
  })
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

  test("emits each occurrence with its schedule id and key, then re-arms for the next", async () => {
    const eventsRuntime = createEvents()
    const clock = createTestClock(new Date("2026-01-01T10:30:00Z"))
    const runtime = new SchedulerRuntime({
      schedules: [defineSchedule("hourly").cron("0 * * * *")],
      events: eventsRuntime,
      now: clock.now,
    })

    await runtime.start()
    clock.advance(30 * MINUTE)
    jest.advanceTimersByTime(30 * MINUTE)

    const [first] = (await eventsRuntime.read({
      types: ["schedule.triggered"],
    })) as StoredScheduleTriggeredEvent[]
    expect(first?.payload).toEqual({
      scheduleId: "hourly",
      occurrenceAt: "2026-01-01T11:00:00.000Z",
      triggeredAt: "2026-01-01T11:00:00.000Z",
      occurrenceKey: "hourly:2026-01-01T11:00:00.000Z",
    })

    clock.advance(60 * MINUTE)
    jest.advanceTimersByTime(60 * MINUTE)

    expect(await firedOccurrences(eventsRuntime)).toEqual([
      "hourly@2026-01-01T11:00:00.000Z",
      "hourly@2026-01-01T12:00:00.000Z",
    ])

    await runtime.stop()
  })

  test("evaluates crons without a time zone in the project time zone", async () => {
    // Proven by removal: drop `?? this.timeZone` from the scheduler; both fire at 08:00 UTC.
    const eventsRuntime = createEvents()
    const clock = createTestClock(new Date("2026-01-01T00:00:00Z"))
    const runtime = new SchedulerRuntime({
      schedules: [
        defineSchedule("project-morning").cron("0 8 * * *"),
        defineSchedule("tokyo-morning").cron("0 8 * * *", { timezone: "Asia/Tokyo" }),
      ],
      events: eventsRuntime,
      timeZone: "Europe/Paris",
      now: clock.now,
    })

    await runtime.start()
    clock.advance(24 * HOUR)
    jest.advanceTimersByTime(24 * HOUR)

    expect((await firedOccurrences(eventsRuntime)).sort()).toEqual([
      "project-morning@2026-01-01T07:00:00.000Z",
      "tokyo-morning@2026-01-01T23:00:00.000Z",
    ])

    await runtime.stop()
  })

  test("emits every schedule due at the same instant", async () => {
    const eventsRuntime = createEvents()
    const clock = createTestClock(new Date("2026-01-01T10:00:00Z"))
    const runtime = new SchedulerRuntime({
      schedules: [
        defineSchedule("every-15").cron("*/15 * * * *"),
        defineSchedule("hourly").cron("0 * * * *"),
      ],
      events: eventsRuntime,
      now: clock.now,
    })

    await runtime.start()
    for (let quarter = 0; quarter < 4; quarter += 1) {
      clock.advance(15 * MINUTE)
      jest.advanceTimersByTime(15 * MINUTE)
    }

    expect(await firedOccurrences(eventsRuntime)).toEqual([
      "every-15@2026-01-01T10:15:00.000Z",
      "every-15@2026-01-01T10:30:00.000Z",
      "every-15@2026-01-01T10:45:00.000Z",
      "every-15@2026-01-01T11:00:00.000Z",
      "hourly@2026-01-01T11:00:00.000Z",
    ])

    await runtime.stop()
  })

  test("duplicate schedule ids throws SchedulerValidationError", async () => {
    const runtime = new SchedulerRuntime({
      schedules: [
        defineSchedule("dup").cron("0 * * * *"),
        defineSchedule("dup").cron("*/5 * * * *"),
      ],
      events: createEvents(),
    })

    await expect(runtime.start()).rejects.toThrow(SchedulerValidationError)
  })

  test("start() is idempotent", async () => {
    const eventsRuntime = createEvents()
    const clock = createTestClock(new Date("2026-01-01T10:00:00Z"))
    const runtime = new SchedulerRuntime({
      schedules: [defineSchedule("s1").cron("0 * * * *")],
      events: eventsRuntime,
      now: clock.now,
    })

    await runtime.start()
    await runtime.start()

    clock.advance(HOUR)
    jest.advanceTimersByTime(HOUR)

    expect(await firedOccurrences(eventsRuntime)).toEqual(["s1@2026-01-01T11:00:00.000Z"])

    await runtime.stop()
  })

  test("stop() prevents further events", async () => {
    const eventsRuntime = createEvents()
    const clock = createTestClock(new Date("2026-01-01T10:30:00Z"))
    const runtime = new SchedulerRuntime({
      schedules: [defineSchedule("s1").cron("0 * * * *")],
      events: eventsRuntime,
      now: clock.now,
    })

    await runtime.start()
    await runtime.stop()

    clock.advance(HOUR)
    jest.advanceTimersByTime(HOUR)

    expect(await firedOccurrences(eventsRuntime)).toEqual([])
  })

  test("no schedules arms no timer", async () => {
    const runtime = new SchedulerRuntime({ schedules: [], events: createEvents() })

    await runtime.start()
    expect(jest.getTimerCount()).toBe(0)
    await runtime.stop()
  })

  // Proven by removal: compute the next occurrence from `now` instead of `occurrenceAt` in `tick()`;
  // the late timer then skips 12:00 and only 11:00 fires.
  test("a late timer catches up every missed occurrence", async () => {
    const eventsRuntime = createEvents()
    const clock = createTestClock(new Date("2026-01-01T10:00:00Z"))
    const runtime = new SchedulerRuntime({
      schedules: [defineSchedule("hourly").cron("0 * * * *")],
      events: eventsRuntime,
      now: clock.now,
    })

    await runtime.start()

    // The process slept through two occurrences: the timer fires once, after the clock moved on.
    clock.advance(150 * MINUTE)
    jest.advanceTimersByTime(150 * MINUTE)

    expect(await firedOccurrences(eventsRuntime)).toEqual([
      "hourly@2026-01-01T11:00:00.000Z",
      "hourly@2026-01-01T12:00:00.000Z",
    ])

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
