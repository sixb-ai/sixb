import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test"
import type { SixbErrorContext } from "@sixb/core"
import { attachSixbErrorReporter, flushSixbErrors } from "@sixb/core/internal/error-reporting"
import { type DispatchJob, JobDispatch } from "../src/job-dispatch"

const TOTAL_BACKOFF_MS = 250 + 500 + 1_000 + 2_000 + 4_000 + 8_000 + 29 * 10_000

function job(target: string, dispatch: () => Promise<void>): DispatchJob {
  return { event: { id: `event:${target}`, type: "schedule.triggered" }, target, dispatch }
}

function failing(target: string, onAttempt?: () => void): DispatchJob {
  return job(target, async () => {
    onAttempt?.()
    throw new Error(`${target} unavailable`)
  })
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve()
}

async function advance(ms: number): Promise<void> {
  jest.advanceTimersByTime(ms)
  await flush()
}

describe("JobDispatch", () => {
  const reported: { error: Error; context: SixbErrorContext }[] = []
  const reporter = {}
  const controller = { current: new AbortController() }

  function createDispatch(): JobDispatch {
    return new JobDispatch({
      projectId: "project",
      reporter,
      signal: controller.current.signal,
    })
  }

  beforeEach(() => {
    reported.length = 0
    controller.current = new AbortController()
    attachSixbErrorReporter(reporter, (error, context) => {
      reported.push({ error, context })
    })
    jest.useFakeTimers()
    spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    controller.current.abort()
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  test("sends jobs in order, one at a time", async () => {
    const order: string[] = []
    const dispatch = createDispatch()

    await dispatch.all([
      job("first", async () => {
        order.push("first:start")
        await Promise.resolve()
        order.push("first:end")
      }),
      job("second", async () => {
        order.push("second")
      }),
    ])

    expect(order).toEqual(["first:start", "first:end", "second"])
  })

  // Reproduce: await `retry` in `one`; the second job waits out every backoff.
  test("a job that fails costs the next one nothing, and retries beside the line", async () => {
    let attempts = 0
    let sent = 0
    const dispatch = createDispatch()

    await dispatch.all([
      failing("bad", () => {
        attempts += 1
      }),
      job("good", async () => {
        sent += 1
      }),
    ])

    expect(sent).toBe(1)
    expect(attempts).toBe(1)

    await advance(249)
    expect(attempts).toBe(1)

    await advance(1)
    expect(attempts).toBe(2)

    await advance(500)
    expect(attempts).toBe(3)
  })

  test("a job that recovers is done, with nothing reported", async () => {
    let attempts = 0
    const dispatch = createDispatch()

    await dispatch.all([
      job("flaky", async () => {
        attempts += 1
        if (attempts === 1) throw new Error("once")
      }),
    ])
    await advance(250)

    expect(attempts).toBe(2)
    await dispatch.drain()

    await flushSixbErrors(reporter)
    expect(reported).toEqual([])
  })

  // Reproduce: raise `MAX_ATTEMPTS`; the job outlives the test and nothing is reported.
  test("drops a job that keeps failing, and reports what it dropped", async () => {
    let attempts = 0
    const dispatch = createDispatch()

    await dispatch.all([
      failing("pipeline:daily", () => {
        attempts += 1
      }),
    ])
    for (let elapsed = 0; elapsed < TOTAL_BACKOFF_MS; elapsed += 250) await advance(250)
    await dispatch.drain()
    await flushSixbErrors(reporter)

    expect(attempts).toBe(36)
    expect(reported).toHaveLength(1)
    expect(reported[0]?.error.message).toBe("pipeline:daily unavailable")
    expect(reported[0]?.context).toMatchObject({
      type: "orchestrator.dispatch.failed",
      projectId: "project",
      eventId: "event:pipeline:daily",
      eventType: "schedule.triggered",
      target: "pipeline:daily",
      attempts: 36,
      failure: { code: "internal.unexpected" },
    })
  })

  // Reproduce: remove the race with `timedOut` in `attempt`; the batch never ends.
  test("a dispatch that hangs counts as a failure, and lets the line move", async () => {
    let attempts = 0
    let sent = 0
    const dispatch = createDispatch()

    const batch = dispatch.all([
      job("hung", () => {
        attempts += 1
        return new Promise(() => {})
      }),
      job("good", async () => {
        sent += 1
      }),
    ])

    await advance(29_999)
    expect(sent).toBe(0)

    await advance(1)
    await batch
    expect(sent).toBe(1)

    await advance(250)
    expect(attempts).toBe(2)
  })

  // Reproduce: drop the `while` in `one`; the batch ends with every failed job in memory.
  test("past its cap the line waits, so the backlog stays in the broker", async () => {
    const dispatch = createDispatch()
    let ended = false

    await dispatch.all(Array.from({ length: 64 }, (_, index) => failing(`bad:${index}`)))
    const batch = dispatch.all([failing("one-too-many")]).then(() => {
      ended = true
    })
    await flush()
    expect(ended).toBe(false)

    for (let elapsed = 0; elapsed < TOTAL_BACKOFF_MS; elapsed += 1_000) await advance(1_000)
    await batch

    expect(ended).toBe(true)
  })

  test("stopping ends the retries at once, and reports nothing", async () => {
    let attempts = 0
    const dispatch = createDispatch()

    await dispatch.all([
      failing("bad", () => {
        attempts += 1
      }),
    ])
    expect(jest.getTimerCount()).toBe(1)

    controller.current.abort()
    await dispatch.drain()
    await advance(60_000)
    await flushSixbErrors(reporter)

    expect(attempts).toBe(1)
    expect(reported).toEqual([])
  })

  test("takes nothing more once stopped", async () => {
    let sent = 0
    const dispatch = createDispatch()
    controller.current.abort()

    await dispatch.all([
      job("late", async () => {
        sent += 1
      }),
    ])

    expect(sent).toBe(0)
  })
})
