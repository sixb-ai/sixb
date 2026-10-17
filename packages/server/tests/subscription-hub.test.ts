import { describe, expect, spyOn, test } from "bun:test"
import { InMemoryBroker } from "@sixb/core"
import { LOGS_STREAM, LoggingService } from "@sixb/core/internal/logging"
import { createLogSubscriptionHub, logSubscription } from "../src/routes/ws/logs"
import { SubscriptionHub } from "../src/routes/ws/subscription-hub"

const PROJECT_ID = "log-subscription-hub-test"
const REPLAY_COUNT = 1_001

class TestLogSocket {
  readonly raw: { bufferedAmount: number }
  readonly messages: Array<{ readonly type?: string; readonly logs?: readonly unknown[] }> = []
  closeCode: number | undefined

  constructor(bufferedAmount = 0) {
    this.raw = { bufferedAmount }
  }

  send(message: string): void {
    this.messages.push(JSON.parse(message) as { type?: string; logs?: readonly unknown[] })
  }

  close(code?: number): void {
    this.closeCode = code
  }

  get deliveredLogCount(): number {
    return this.messages.reduce((count, message) => count + (message.logs?.length ?? 0), 0)
  }
}

class CountingSubscribeBroker extends InMemoryBroker {
  active = 0

  override async subscribe(
    params: Parameters<InMemoryBroker["subscribe"]>[0],
    handler: Parameters<InMemoryBroker["subscribe"]>[1]
  ): Promise<() => void> {
    const unsubscribe = await super.subscribe(params, handler)
    this.active += 1
    let subscribed = true
    return () => {
      if (subscribed) this.active -= 1
      subscribed = false
      unsubscribe()
    }
  }
}

class DelayedSubscribeBroker extends InMemoryBroker {
  private readonly subscribeStarted = new Deferred<void>()
  private readonly subscribeRelease = new Deferred<void>()

  waitForSubscribeStart(): Promise<void> {
    return this.subscribeStarted.promise
  }

  releaseSubscribe(): void {
    this.subscribeRelease.resolve()
  }

  override async subscribe(
    params: Parameters<InMemoryBroker["subscribe"]>[0],
    handler: Parameters<InMemoryBroker["subscribe"]>[1]
  ): Promise<() => void> {
    this.subscribeStarted.resolve()
    await this.subscribeRelease.promise
    return super.subscribe(params, handler)
  }
}

describe("SubscriptionHub", () => {
  test("replays more than the client queue capacity without treating catch-up as a slow client", async () => {
    const { anchorCursor, hub, logging } = await createReplayHub()
    const socket = new TestLogSocket()

    try {
      await hub.subscribe(
        {},
        socket,
        logSubscription(logging, { afterCursor: anchorCursor }),
        () => undefined
      )
      await waitFor(
        () => socket.closeCode !== undefined || socket.deliveredLogCount === REPLAY_COUNT
      )

      expect(socket.closeCode).toBeUndefined()
      expect(socket.deliveredLogCount).toBe(REPLAY_COUNT)
    } finally {
      await hub.close()
    }
  })

  test("still closes a replay when the socket buffer is over the backpressure limit", async () => {
    const { anchorCursor, hub, logging } = await createReplayHub()
    const socket = new TestLogSocket(1_048_577)

    try {
      await hub.subscribe(
        {},
        socket,
        logSubscription(logging, { afterCursor: anchorCursor }),
        () => undefined
      )
      await waitFor(() => socket.closeCode !== undefined)

      expect(socket.closeCode).toBe(1013)
      expect(socket.deliveredLogCount).toBe(0)
    } finally {
      await hub.close()
    }
  })

  test("does not install a client that unsubscribes while hub startup is pending", async () => {
    const broker = new DelayedSubscribeBroker()
    const logging = new LoggingService({ projectId: PROJECT_ID, broker })
    const hub = createLogSubscriptionHub(logging)
    const socket = new TestLogSocket()
    const key = {}
    let subscribed = false

    const pendingSubscribe = hub.subscribe(key, socket, logSubscription(logging, {}), () => {
      subscribed = true
    })
    await broker.waitForSubscribeStart()
    hub.unsubscribe(key)
    broker.releaseSubscribe()

    try {
      await pendingSubscribe
      expect(subscribed).toBe(false)
    } finally {
      await hub.close()
    }
  })

  test("only installs the latest subscription when two requests race during startup", async () => {
    const broker = new DelayedSubscribeBroker()
    const logging = new LoggingService({ projectId: PROJECT_ID, broker })
    const hub = createLogSubscriptionHub(logging)
    const socket = new TestLogSocket()
    const key = {}
    const subscribed: string[] = []

    const first = hub.subscribe(key, socket, logSubscription(logging, { kinds: ["sync"] }), () => {
      subscribed.push("first")
    })
    await broker.waitForSubscribeStart()
    const second = hub.subscribe(
      key,
      socket,
      logSubscription(logging, { kinds: ["workflow"] }),
      () => {
        subscribed.push("second")
      }
    )
    broker.releaseSubscribe()

    try {
      await Promise.all([first, second])
      expect(subscribed).toEqual(["second"])
    } finally {
      await hub.close()
    }
  })

  test("does not install a pending client after the hub closes", async () => {
    const broker = new DelayedSubscribeBroker()
    const logging = new LoggingService({ projectId: PROJECT_ID, broker })
    const hub = createLogSubscriptionHub(logging)
    let subscribed = false

    const pendingSubscribe = hub.subscribe(
      {},
      new TestLogSocket(),
      logSubscription(logging, {}),
      () => {
        subscribed = true
      }
    )
    await broker.waitForSubscribeStart()
    await hub.close()
    broker.releaseSubscribe()
    await pendingSubscribe

    expect(subscribed).toBe(false)
  })

  // Reproduce: drop the `release()` call from `deleteClient`, or the restart loop in `subscribe`,
  // in subscription-hub.ts.
  test("releases the broker subscription when the last client leaves and restarts it on demand", async () => {
    const broker = new CountingSubscribeBroker()
    const logging = new LoggingService({ projectId: PROJECT_ID, broker })
    const hub = createLogSubscriptionHub(logging)
    const first = {}
    const second = {}

    try {
      await hub.subscribe(first, new TestLogSocket(), logSubscription(logging, {}), () => undefined)
      await hub.subscribe(
        second,
        new TestLogSocket(),
        logSubscription(logging, {}),
        () => undefined
      )
      expect(broker.active).toBe(1)

      hub.unsubscribe(first)
      expect(broker.active).toBe(1)
      hub.unsubscribe(second)
      await waitFor(() => broker.active === 0)

      await hub.subscribe(first, new TestLogSocket(), logSubscription(logging, {}), () => undefined)
      // The last client leaves while the next subscribe waits on the started subscription.
      const socket = new TestLogSocket()
      const pending = hub.subscribe(second, socket, logSubscription(logging, {}), () => undefined)
      hub.unsubscribe(first)
      await pending
      await waitFor(() => broker.active === 1)
      await broker.append({
        projectId: PROJECT_ID,
        streamId: LOGS_STREAM.id,
        records: [{ name: "workflow.info", payload: logPayload("after restart") }],
      })
      await waitFor(() => socket.deliveredLogCount === 1)
    } finally {
      await hub.close()
    }
    await waitFor(() => broker.active === 0)
  })

  // Reproduce: drop the `sending` check from `flush` in subscription-hub.ts; the second batch is
  // sent while the first one still waits for its view.
  test("sends batches in order while a view waits", async () => {
    const { deliver, hub } = await createManualHub()
    const socket = new TestRecordSocket()
    const firstView = new Deferred<void>()
    let views = 0

    try {
      await hub.subscribe(
        {},
        socket,
        {
          matches: () => true,
          view: async (records) => {
            views += 1
            if (views === 1) await firstView.promise
            return records.map((record) => ({ ...record, value: `viewed ${record.value}` }))
          },
        },
        () => undefined
      )

      deliver([{ cursor: "1", value: "first" }])
      await waitFor(() => views === 1)
      deliver([{ cursor: "2", value: "second" }])
      await Bun.sleep(30)
      expect(socket.values).toEqual([])

      firstView.resolve()
      await waitFor(() => socket.values.length === 2)
      expect(socket.values).toEqual(["viewed first", "viewed second"])
    } finally {
      await hub.close()
    }
  })

  // Reproduce: send `records` instead of failing in the `catch` of `sendViewed` in
  // subscription-hub.ts; the batch is sent unviewed. Return without failing; the socket stays
  // open and delivers the next batch, past the withheld one.
  test("closes the stream at a batch its view fails on, sending nothing of it or after it", async () => {
    const { deliver, hub } = await createManualHub()
    const socket = new TestRecordSocket()
    // Keeps the hub subscribed once the failing client is gone.
    const other = new TestRecordSocket()
    const warn = spyOn(console, "warn").mockImplementation(() => undefined)
    let fail = true

    try {
      await hub.subscribe(
        {},
        socket,
        {
          matches: () => true,
          view: async (records) => {
            if (fail) throw new Error("clearance unavailable")
            return records
          },
        },
        () => undefined
      )
      await hub.subscribe({}, other, { matches: () => true }, () => undefined)

      deliver([{ cursor: "1", value: "secret" }])
      await waitFor(() => warn.mock.calls.length === 1)
      expect(String(warn.mock.calls[0]?.[0])).toBe(
        "[SixbServer] Closed a stream subscription at cursor '1': 1 record(s) could not be viewed: clearance unavailable"
      )
      expect(socket.closeCode).toBe(1011)

      fail = false
      deliver([{ cursor: "2", value: "later" }])
      await waitFor(() => other.values.length === 2)
      expect(socket.values).toEqual([])
      expect(socket.messages).toEqual([
        {
          type: "error",
          message: "Stream records could not be viewed; reconnect from the last cursor.",
        },
      ])
    } finally {
      warn.mockRestore()
      await hub.close()
    }
  })
})

interface TestRecord {
  readonly cursor: string
  readonly value: string
}

class TestRecordSocket {
  readonly values: string[] = []
  /** Frames other than records. */
  readonly messages: unknown[] = []
  closeCode: number | undefined

  send(message: string): void {
    const frame = JSON.parse(message) as { readonly records?: readonly TestRecord[] }
    if (!frame.records) this.messages.push(frame)
    this.values.push(...(frame.records ?? []).map((record) => record.value))
  }

  close(code?: number): void {
    this.closeCode = code
  }
}

/** A hub over a source whose records the test delivers itself. */
async function createManualHub(): Promise<{
  readonly deliver: (records: readonly TestRecord[]) => void
  readonly hub: SubscriptionHub<TestRecord>
}> {
  let deliverTo: ((records: readonly TestRecord[]) => void) | undefined
  const hub = new SubscriptionHub<TestRecord>({
    subscribe: async (deliver) => {
      deliverTo = deliver
      return () => {
        deliverTo = undefined
      }
    },
    frames: (records) => [{ type: "records", records }],
    expired: async () => ({ type: "expired" }),
  })

  return {
    deliver: (records) => {
      if (!deliverTo) throw new Error("[Test] The hub is not subscribed.")
      deliverTo(records)
    },
    hub,
  }
}

async function createReplayHub(): Promise<{
  readonly anchorCursor: string
  readonly hub: ReturnType<typeof createLogSubscriptionHub>
  readonly logging: LoggingService
}> {
  const broker = new InMemoryBroker()
  const logging = new LoggingService({ projectId: PROJECT_ID, broker })
  const hub = createLogSubscriptionHub(logging)

  await broker.ensureStream({ projectId: PROJECT_ID, stream: LOGS_STREAM })
  const [anchor] = await broker.append({
    projectId: PROJECT_ID,
    streamId: LOGS_STREAM.id,
    records: [{ payload: logPayload("anchor") }],
  })
  if (!anchor) throw new Error("Expected an anchor log record")

  await broker.append({
    projectId: PROJECT_ID,
    streamId: LOGS_STREAM.id,
    records: Array.from({ length: REPLAY_COUNT }, (_, index) => ({
      name: "workflow.info",
      key: "workflow:wf-1",
      payload: logPayload(`replayed ${index + 1}`),
    })),
  })

  return { anchorCursor: anchor.cursor, hub, logging }
}

function logPayload(message: string) {
  return {
    level: "info",
    message,
    at: "2026-07-11T00:00:00.000Z",
    context: { run: { kind: "workflow", id: "wf-1" } },
  } as const
}

async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for log replay to finish")
    }
    await Bun.sleep(5)
  }
}

class Deferred<T> {
  readonly promise: Promise<T>
  resolve!: (value: T | PromiseLike<T>) => void

  constructor() {
    this.promise = new Promise((resolve) => {
      this.resolve = resolve
    })
  }
}
