import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test"
import { PipelineError, type SixbErrorContext, WorkflowValidationError } from "@sixb/core"
import { attachSixbErrorReporter, flushSixbErrors } from "@sixb/core/internal/error-reporting"
import { createSixbError } from "@sixb/core/internal/errors"
import { type DispatchJob, JobDispatch } from "../src/job-dispatch"

/** The backoff up to the attempt that reports a job still retrying. */
const BACKOFF_UNTIL_REPORT_MS = 250 + 500 + 1_000 + 2_000 + 4_000 + 8_000 + 29 * 10_000

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

  // Reproduce: return after `REPORT_AFTER_ATTEMPTS` in `retry`, as dropping did; an outage longer
  // than five minutes loses the trigger, and the last attempt below never happens.
  test("an outage retries for as long as it lasts, and is reported once", async () => {
    let healthy = false
    let attempts = 0
    let sent = false
    const dispatch = createDispatch()

    await dispatch.all([
      job("pipeline:daily", async () => {
        attempts += 1
        if (!healthy) throw new Error("connection refused")
        sent = true
      }),
    ])

    const backoff = BACKOFF_UNTIL_REPORT_MS + 60 * 60_000
    for (let elapsed = 0; elapsed < backoff; elapsed += 1_000) await advance(1_000)
    await flushSixbErrors(reporter)

    expect(attempts).toBeGreaterThan(36)
    expect(sent).toBe(false)
    expect(reported).toHaveLength(1)
    expect(reported[0]?.context).toMatchObject({
      type: "orchestrator.dispatch.failed",
      projectId: "project",
      eventId: "event:pipeline:daily",
      eventType: "schedule.triggered",
      target: "pipeline:daily",
      attempts: 36,
      dropped: false,
    })

    healthy = true
    await advance(10_000)
    await dispatch.drain()

    expect(sent).toBe(true)
    await flushSixbErrors(reporter)
    expect(reported).toHaveLength(1)
  })

  // Reproduce: return false from `isPermanentDispatchFailure`; each of these retries forever.
  test.each([
    { name: "a framework error that says so", error: createSixbError("internal.unexpected", "x") },
    { name: "an invalid workflow request", error: new WorkflowValidationError("bad input") },
    { name: "a definition a dispatcher refuses", error: new PipelineError("unknown pipeline") },
  ])("drops at once, and reports, $name", async ({ error }) => {
    let attempts = 0
    const dispatch = createDispatch()

    await dispatch.all([
      job("workflow:notify", async () => {
        attempts += 1
        throw error
      }),
    ])
    await advance(60_000)
    await dispatch.drain()
    await flushSixbErrors(reporter)

    expect(attempts).toBe(1)
    expect(reported).toHaveLength(1)
    expect(reported[0]?.context).toMatchObject({ attempts: 1, dropped: true })
  })

  test("keeps retrying what the framework calls retryable", async () => {
    let attempts = 0
    const dispatch = createDispatch()

    await dispatch.all([
      job("sync:orders", async () => {
        attempts += 1
        throw createSixbError("storage.unavailable", "PostgreSQL is unavailable")
      }),
    ])
    await advance(250)
    await advance(500)

    expect(attempts).toBe(3)
    await flushSixbErrors(reporter)
    expect(reported).toEqual([])
  })

  test("a retry that turns out permanent stops there", async () => {
    let attempts = 0
    const dispatch = createDispatch()

    await dispatch.all([
      job("workflow:notify", async () => {
        attempts += 1
        throw attempts === 1 ? new Error("connection reset") : new WorkflowValidationError("bad")
      }),
    ])
    await advance(250)
    await advance(60_000)
    await dispatch.drain()
    await flushSixbErrors(reporter)

    expect(attempts).toBe(2)
    expect(reported[0]?.context).toMatchObject({ attempts: 2, dropped: true })
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
    let healthy = false
    const dispatch = createDispatch()
    const outage = (target: string) =>
      job(target, async () => {
        if (!healthy) throw new Error("connection refused")
      })
    let ended = false

    await dispatch.all(Array.from({ length: 64 }, (_, index) => outage(`job:${index}`)))
    const batch = dispatch.all([outage("one-too-many")]).then(() => {
      ended = true
    })
    for (let elapsed = 0; elapsed < 30 * 60_000; elapsed += 10_000) await advance(10_000)
    expect(ended).toBe(false)

    healthy = true
    await advance(10_000)
    await batch

    expect(ended).toBe(true)
  })

  test("a permanent failure takes no slot, so a full line still moves past it", async () => {
    const dispatch = createDispatch()

    await dispatch.all(Array.from({ length: 64 }, (_, index) => failing(`bad:${index}`)))
    await dispatch.all([
      job("invalid", async () => {
        throw new WorkflowValidationError("bad input")
      }),
    ])

    await flushSixbErrors(reporter)
    expect(reported[0]?.context).toMatchObject({ target: "invalid", dropped: true })
  })

  // Reproduce: drop the abort listener in `sleep`; a stop waits behind the backoff of every retry.
  test("stopping releases a line that waits for a slot", async () => {
    const dispatch = createDispatch()

    await dispatch.all(Array.from({ length: 64 }, (_, index) => failing(`bad:${index}`)))
    const batch = dispatch.all([failing("one-too-many")])
    await flush()

    controller.current.abort()
    await batch
    await dispatch.drain()

    expect(jest.getTimerCount()).toBe(0)
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
