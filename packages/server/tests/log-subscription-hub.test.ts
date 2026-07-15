import { describe, expect, test } from "bun:test"
import { InMemoryBroker, type OntologySource, type Sixb } from "@sixb/core"
import { LOGS_STREAM, LogsRuntime } from "@sixb/core/internal/logging"
import { LogSubscriptionHub } from "../src/routes/ws/log-subscription-hub"

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

describe("LogSubscriptionHub", () => {
  test("replays more than the client queue capacity without treating catch-up as a slow client", async () => {
    const { anchorCursor, hub } = await createReplayHub()
    const socket = new TestLogSocket()

    try {
      await hub.subscribe({}, socket, { afterCursor: anchorCursor }, () => undefined)
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
    const { anchorCursor, hub } = await createReplayHub()
    const socket = new TestLogSocket(1_048_577)

    try {
      await hub.subscribe({}, socket, { afterCursor: anchorCursor }, () => undefined)
      await waitFor(() => socket.closeCode !== undefined)

      expect(socket.closeCode).toBe(1013)
      expect(socket.deliveredLogCount).toBe(0)
    } finally {
      await hub.close()
    }
  })

  test("does not install a client that unsubscribes while hub startup is pending", async () => {
    const broker = new DelayedSubscribeBroker()
    const logs = new LogsRuntime({ projectId: PROJECT_ID, broker })
    const sixb = { logs } as unknown as Sixb<readonly OntologySource[]>
    const hub = new LogSubscriptionHub(sixb)
    const socket = new TestLogSocket()
    const key = {}
    let subscribed = false

    const pendingSubscribe = hub.subscribe(key, socket, {}, () => {
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
    const logs = new LogsRuntime({ projectId: PROJECT_ID, broker })
    const sixb = { logs } as unknown as Sixb<readonly OntologySource[]>
    const hub = new LogSubscriptionHub(sixb)
    const socket = new TestLogSocket()
    const key = {}
    const subscribed: string[] = []

    const first = hub.subscribe(key, socket, { kinds: ["sync"] }, () => {
      subscribed.push("first")
    })
    await broker.waitForSubscribeStart()
    const second = hub.subscribe(key, socket, { kinds: ["workflow"] }, () => {
      subscribed.push("second")
    })
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
    const logs = new LogsRuntime({ projectId: PROJECT_ID, broker })
    const sixb = { logs } as unknown as Sixb<readonly OntologySource[]>
    const hub = new LogSubscriptionHub(sixb)
    let subscribed = false

    const pendingSubscribe = hub.subscribe({}, new TestLogSocket(), {}, () => {
      subscribed = true
    })
    await broker.waitForSubscribeStart()
    await hub.close()
    broker.releaseSubscribe()
    await pendingSubscribe

    expect(subscribed).toBe(false)
  })
})

async function createReplayHub(): Promise<{
  readonly anchorCursor: string
  readonly hub: LogSubscriptionHub
}> {
  const broker = new InMemoryBroker()
  const logs = new LogsRuntime({ projectId: PROJECT_ID, broker })
  const sixb = { logs } as unknown as Sixb<readonly OntologySource[]>
  const hub = new LogSubscriptionHub(sixb)

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

  return { anchorCursor: anchor.cursor, hub }
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
