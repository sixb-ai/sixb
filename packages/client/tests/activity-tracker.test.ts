import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import {
  ActivityDeliveryError,
  ActivityTracker,
  type ActivityTrackerOptions,
} from "../src/activity-tracker"

type Batch = Parameters<ActivityTrackerOptions["send"]>[0]

/** A document whose visibility and input the test drives, trusted or synthetic. */
class ActivityDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible"
  private inputListener: EventListenerOrEventListenerObject | null = null

  visibility(value: DocumentVisibilityState) {
    this.visibilityState = value
    this.dispatchEvent(new Event("visibilitychange"))
  }

  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean
  ) {
    super.addEventListener(type, listener, options)
    if (type === "pointerdown") {
      this.inputListener = listener
    }
  }

  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean
  ) {
    super.removeEventListener(type, listener, options)
    if (type === "pointerdown") {
      this.inputListener = null
    }
  }

  /** `isTrusted` cannot be set on a constructed event, so the listener gets a proxy. */
  input(trusted: boolean) {
    const event = new Proxy(new Event("pointerdown"), {
      get: (target, key) => (key === "isTrusted" ? trusted : Reflect.get(target, key, target)),
    })

    if (typeof this.inputListener === "function") {
      this.inputListener.call(this, event)
    } else {
      this.inputListener?.handleEvent(event)
    }
  }
}

const trackers: ActivityTracker[] = []

beforeEach(() => {
  jest.useFakeTimers()
})

afterEach(() => {
  for (const tracker of trackers.splice(0)) {
    tracker.dispose()
  }
  jest.useRealTimers()
})

async function setup(overrides: Partial<ActivityTrackerOptions> = {}) {
  const document = new ActivityDocument()
  const sent: Batch[] = []
  const warnings: string[] = []
  let now = 1_000_000

  const tracker = new ActivityTracker({
    document,
    now: () => now,
    load: async () => ({ enabled: true, idleTimeoutMs: 60_000 }),
    send: async (events) => {
      sent.push(events)
    },
    warn: (message) => warnings.push(message),
    ...overrides,
  })
  trackers.push(tracker)
  await Promise.resolve()

  const advance = (ms: number) => {
    now += ms
  }
  return { tracker, document, sent, warnings, advance }
}

function attributionOf(event: Batch[number] | undefined) {
  return event && "attribution" in event ? event.attribution : undefined
}

function ofType(sent: readonly Batch[], type: "page.view" | "visit.activity") {
  return sent.flat().filter((event) => event.type === type)
}

describe("activity browser delivery", () => {
  test("disabled settings and hidden pages collect nothing", async () => {
    const disabled = await setup({ load: async () => ({ enabled: false, idleTimeoutMs: 60_000 }) })
    disabled.tracker.page("/")
    await disabled.tracker.flush()
    expect(disabled.sent).toEqual([])

    const { tracker, document, sent } = await setup()
    document.visibility("hidden")
    tracker.page("/invoices/:id")
    await tracker.flush()
    expect(sent).toEqual([])

    document.visibility("visible")
    await tracker.flush()
    expect(sent.flat().map((event) => event.route)).toEqual(["/invoices/:id"])
  })

  test("a page that is not recorded sends nothing, not even activity", async () => {
    const { tracker, document, sent, advance } = await setup()
    tracker.page(null)
    advance(60_000)
    document.input(true)
    document.visibility("hidden")
    document.visibility("visible")
    await tracker.flush()

    expect(sent).toEqual([])
  })

  // Guard proof: remove the isTrusted check from onInput; the synthetic input is sent.
  test("idle tabs and synthetic events do not prolong visits; real foreground input does", async () => {
    const { tracker, document, sent, advance } = await setup()
    tracker.page("/")
    await tracker.flush()

    advance(60_000)
    jest.advanceTimersByTime(60_000)
    document.input(false)
    document.visibility("hidden")
    await tracker.flush()
    expect(sent.flat()).toHaveLength(1)

    document.visibility("visible")
    await tracker.flush()
    advance(60_000)
    document.input(true)
    await tracker.flush()
    expect(sent.flat().at(-1)?.type).toBe("visit.activity")

    advance(1_000)
    document.input(true)
    document.visibility("hidden")
    await tracker.flush()
    expect(sent.flat().at(-1)?.type).toBe("visit.activity")
  })

  test("retries keep their ids, stop after three failures, and concurrent flushes share one", async () => {
    const attempts: Batch[] = []
    const { tracker, warnings } = await setup({
      send: async (events) => {
        attempts.push(events)
        throw Error("offline")
      },
    })
    tracker.page("/invoices/:id")

    const first = tracker.flush()
    expect(tracker.flush()).toBe(first)
    await first
    await tracker.flush()
    await tracker.flush()
    await tracker.flush()

    expect(attempts).toHaveLength(3)
    expect(attempts[1]).toEqual(attempts[0])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).not.toContain("invoices")
  })

  test("the queue, its batches and the age of events stay bounded", async () => {
    const { tracker, sent, warnings, advance } = await setup()
    for (let index = 0; index < 105; index++) {
      tracker.page("/")
    }
    for (let index = 0; index < 6; index++) {
      await tracker.flush()
    }
    expect(sent.map((batch) => batch.length)).toEqual([20, 20, 20, 20, 20])
    expect(warnings).toHaveLength(5)

    tracker.page("/expired")
    advance(60_001)
    await tracker.flush()
    expect(sent.flat()).toHaveLength(100)
  })

  test("disposing aborts pending delivery and cannot revive a previous authority", async () => {
    let resolveLoad: (value: { enabled: boolean; idleTimeoutMs: number }) => void = () => {}
    let signal: AbortSignal | undefined
    const { tracker, sent } = await setup({
      load: (value) => {
        signal = value
        return new Promise((resolve) => {
          resolveLoad = resolve
        })
      },
    })

    tracker.page("/old-user")
    tracker.dispose()
    resolveLoad({ enabled: true, idleTimeoutMs: 60_000 })
    await Promise.resolve()
    await tracker.flush()

    expect(signal?.aborted).toBe(true)
    expect(sent).toEqual([])
  })
})

// Guard proof: raise REQUEST_TIMEOUT_MS to 60 seconds; the request is not aborted in time.
test("a stalled request is aborted and retried with the same event id", async () => {
  const attempts: Batch[] = []
  let requestSignal: AbortSignal | undefined
  const { tracker } = await setup({
    send: async (events, signal) => {
      attempts.push(events)
      requestSignal = signal
      if (attempts.length === 1) {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(Error("timeout")), { once: true })
        })
      }
    },
  })

  tracker.page("/")
  const pending = tracker.flush()
  jest.advanceTimersByTime(10_000)
  expect(requestSignal?.aborted).toBe(true)

  await pending
  await tracker.flush()
  expect(attempts).toHaveLength(2)
  expect(attempts[1]).toEqual(attempts[0])
})

// Guard proof: send page.view from onVisibility and onInput; the page-view count grows.
test("returning to a viewed tab and resuming input add activity, not page views", async () => {
  const { tracker, document, sent, advance } = await setup()
  tracker.page("/invoices/:id")
  await tracker.flush()

  for (let index = 0; index < 3; index++) {
    document.visibility("hidden")
    await tracker.flush()
    document.visibility("visible")
    await tracker.flush()
  }
  expect(ofType(sent, "page.view")).toHaveLength(1)
  expect(ofType(sent, "visit.activity")).toHaveLength(3)

  advance(60_000)
  document.input(true)
  await tracker.flush()
  expect(ofType(sent, "page.view")).toHaveLength(1)
  expect(ofType(sent, "visit.activity")).toHaveLength(4)
})

// Guard proof: always send visit.activity from onVisibility; the deferred page view disappears.
test("a navigation while hidden counts its visible destination once", async () => {
  const { tracker, document, sent } = await setup()
  tracker.page("/")
  await tracker.flush()

  document.visibility("hidden")
  tracker.page("/loading")
  tracker.page("/reports")
  await tracker.flush()
  expect(sent.flat()).toHaveLength(1)

  document.visibility("visible")
  await tracker.flush()
  document.visibility("hidden")
  await tracker.flush()
  document.visibility("visible")
  await tracker.flush()

  expect(ofType(sent, "page.view").map((event) => event.route)).toEqual(["/", "/reports"])
  expect(sent.flat().at(-1)?.type).toBe("visit.activity")
})

test("the arrival travels once, a retry keeps it, and later inactivity starts direct", async () => {
  const attempts: Batch[] = []
  const { tracker, advance, document } = await setup({
    attribution: { source: "newsletter", medium: "email" },
    send: async (events) => {
      attempts.push(events)
      if (attempts.length === 1) {
        throw new Error("offline")
      }
    },
  })

  tracker.page("/")
  await tracker.flush()
  await tracker.flush()
  expect(attempts[1]).toEqual(attempts[0])
  expect(attributionOf(attempts[0]?.[0])).toEqual({ source: "newsletter", medium: "email" })

  tracker.page("/next")
  await tracker.flush()
  expect(attributionOf(attempts.at(-1)?.[0])).toEqual({})

  advance(60_000)
  document.input(true)
  await tracker.flush()
  expect(attributionOf(attempts.at(-1)?.[0])).toEqual({})
})

// Guard proof: drop the 4xx branch in sendBatch; the refused batch is sent three times.
test("a refused batch is dropped at once, without retries", async () => {
  const attempts: Batch[] = []
  const { tracker, warnings } = await setup({
    send: async (events) => {
      attempts.push(events)
      throw new ActivityDeliveryError(403)
    },
  })

  tracker.page("/")
  await tracker.flush()
  await tracker.flush()

  expect(attempts).toHaveLength(1)
  expect(warnings).toHaveLength(1)
})

// Guard proof: drop the 429 branch in sendBatch; the batch is retried before Retry-After.
test("a throttled batch waits for Retry-After, at most as long as events are kept", async () => {
  const attempts: Batch[] = []
  const { tracker, advance, warnings } = await setup({
    send: async (events) => {
      attempts.push(events)
      if (attempts.length === 1) {
        throw new ActivityDeliveryError(429, 5_000)
      }
      if (attempts.length === 2) {
        throw new ActivityDeliveryError(429, 3_600_000)
      }
    },
  })

  tracker.page("/")
  await tracker.flush()
  advance(4_999)
  await tracker.flush()
  expect(attempts).toHaveLength(1)

  advance(1)
  await tracker.flush()
  expect(attempts).toHaveLength(2)
  expect(attempts[1]).toEqual(attempts[0])

  // An hour's wait is cut to the minute events are kept; by then this one has expired.
  advance(60_000)
  await tracker.flush()
  expect(attempts).toHaveLength(2)
  expect(warnings).toHaveLength(1)
})
