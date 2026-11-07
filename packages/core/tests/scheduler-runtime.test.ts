import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import { InMemoryBroker } from "../src"
import type { StoredScheduleTriggeredEvent } from "../src/events"
import { DomainEventService } from "../src/events"
import type { MaintenanceFailure } from "../src/maintenance"
import { SchedulerRuntime, SchedulerValidationError } from "../src/scheduler"
import { defineSchedule } from "../src/schedules"

const PROJECT = "test"

function createEvents() {
  return new DomainEventService({ projectId: PROJECT, broker: new InMemoryBroker() })
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

async function flushAsync(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve()
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

  // Reproduce: move on in `fireDue` when `appendOccurrence` rejects; the occurrence is gone and the
  // pass counts as a success.
  test("an occurrence the broker refuses is retried until accepted, then only it fires", async () => {
    const clock = createTestClock(new Date("2026-01-01T01:59:30Z"))
    const events = createEvents()
    const append = events.append.bind(events)
    let refusing = true
    events.append = (input) =>
      refusing ? Promise.reject(new Error("broker unavailable")) : append(input)
    const failures: MaintenanceFailure[] = []
    const scheduler = new SchedulerRuntime({
      schedules: [defineSchedule("hourly").cron("0 * * * *")],
      events,
      now: clock.now,
      onError: (_error, failure) => failures.push(failure),
    })
    await scheduler.start()

    const pass = async (ms: number) => {
      clock.advance(ms)
      jest.advanceTimersByTime(ms)
      await flushAsync()
    }

    await pass(30_000)
    expect(failures).toEqual([{ passId: "cron", consecutiveFailures: 1 }])
    expect(await firedOccurrences(events)).toEqual([])

    await pass(10_000)
    expect(failures).toHaveLength(2)

    // The outage outlasts the next occurrence, which is not caught up.
    for (let elapsed = 0; elapsed < 65; elapsed++) await pass(MINUTE)
    refusing = false
    await pass(10_000)

    expect(await firedOccurrences(events)).toEqual(["hourly@2026-01-01T02:00:00.000Z"])

    const fired = failures.length
    await pass(HOUR)
    expect(failures).toHaveLength(fired)
    expect((await firedOccurrences(events)).length).toBe(2)

    await scheduler.stop()
  })

  test("a schedule the broker refuses costs the others nothing", async () => {
    const clock = createTestClock(new Date("2026-01-01T00:00:30Z"))
    const events = createEvents()
    const append = events.append.bind(events)
    events.append = (input) => {
      const [event] = input.events
      const refused = event?.type === "schedule.triggered" && event.payload.scheduleId === "bad"
      return refused ? Promise.reject(new Error("too large")) : append(input)
    }
    const scheduler = new SchedulerRuntime({
      schedules: [
        defineSchedule("bad").cron("* * * * *"),
        defineSchedule("good").cron("* * * * *"),
      ],
      events,
      now: clock.now,
      onError: () => {},
    })
    await scheduler.start()

    clock.advance(30_000)
    jest.advanceTimersByTime(30_000)
    await flushAsync()

    expect(await firedOccurrences(events)).toEqual(["good@2026-01-01T00:01:00.000Z"])

    await scheduler.stop()
  })

  // Reproduce: drop `idempotencyKey` from `appendOccurrence`; each scheduler stores its own event.
  test("two schedulers on one broker fire an occurrence once", async () => {
    const start = new Date("2026-01-01T00:00:30.000Z")
    const clock = createTestClock(start)
    const events = createEvents()
    const schedules = [defineSchedule("minutely").cron("* * * * *")]
    const first = new SchedulerRuntime({ schedules, events, now: clock.now })
    const second = new SchedulerRuntime({ schedules, events, now: clock.now })
    await first.start()
    await second.start()

    clock.advance(30_000)
    jest.advanceTimersByTime(30_000)
    await flushAsync()

    expect(await firedOccurrences(events)).toEqual(["minutely@2026-01-01T00:01:00.000Z"])

    await first.stop()
    await second.stop()
  })

  // Reproduce: remove the race with `aborted` in `appendOccurrence`; the hung append holds the
  // pass's slot, so nothing fires after it.
  test("an append that never settles does not hold the pass", async () => {
    const clock = createTestClock(new Date("2026-01-01T00:00:30.000Z"))
    const events = createEvents()
    const append = events.append.bind(events)
    let hung = false
    events.append = (input) => {
      if (hung) return append(input)

      hung = true
      void append(input)
      return new Promise(() => {})
    }
    const failures: MaintenanceFailure[] = []
    const scheduler = new SchedulerRuntime({
      schedules: [defineSchedule("minutely").cron("* * * * *")],
      events,
      now: clock.now,
      onError: (_error, failure) => failures.push(failure),
    })
    await scheduler.start()

    for (const elapsed of [30_000, 5_000, 10_000, 45_000]) {
      clock.advance(elapsed)
      jest.advanceTimersByTime(elapsed)
      await flushAsync()
    }

    expect(failures[0]).toEqual({ passId: "cron", consecutiveFailures: 1 })
    expect(await firedOccurrences(events)).toEqual([
      "minutely@2026-01-01T00:01:00.000Z",
      "minutely@2026-01-01T00:02:00.000Z",
    ])
  })

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
