import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Client } from "../src/generated/client"
import { logs, type SixbLogLine } from "../src/logs"
import { parseLogStreamMessage } from "../src/logs-transport"

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  readonly sent: string[] = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null

  constructor(
    readonly url: string,
    readonly protocols?: string | string[]
  ) {
    FakeWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
    this.onclose?.()
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function line(cursor: string, message = "hello"): SixbLogLine {
  return {
    cursor,
    level: "info",
    message,
    at: "2026-01-01T00:00:00.000Z",
    context: { run: { kind: "workflow", id: "wf-1" } },
  }
}

function fakeClient() {
  const calls: Array<{ method: "get" | "post"; options: Record<string, unknown> }> = []
  const client = {
    getConfig: () => ({ baseUrl: "https://api.example.test" }),
    get: async (options: Record<string, unknown>) => {
      calls.push({ method: "get", options })
      return {
        data: { lines: [line("c1")], cursor: "c1", hasMore: false, count: 1 },
      }
    },
  } as unknown as Client
  return { client, calls }
}

describe("logs builder", () => {
  test("keeps run kinds explicit and composes immutable server filters", () => {
    const base = logs.workflows()
    const scoped = base.run("wf-1").level("warn")
    expect(base.ir).toEqual({ kinds: ["workflow"] })
    expect(scoped.ir).toEqual({
      kinds: ["workflow"],
      run: { kind: "workflow", id: "wf-1" },
      level: "warn",
    })
    expect(logs.all().ir).toEqual({})
    expect(() => logs.workflows().run("")).toThrow("runId must be a non-empty string")
    expect(() => logs.workflows().run("   ")).toThrow("runId must be a non-empty string")
  })

  test("returns the complete page contract for forward and recent reads", async () => {
    const fake = fakeClient()
    const builder = logs.workflows({ client: fake.client }).run("wf-1").level("info")

    expect(await builder.read({ afterCursor: "c0", limit: 20 })).toEqual({
      lines: [line("c1")],
      cursor: "c1",
      hasMore: false,
    })
    await builder.tail({ beforeCursor: "c9", limit: 10 })

    expect(fake.calls[0]?.options.query).toEqual({
      kind: "workflow",
      runId: "wf-1",
      level: "info",
      direction: "forward",
      afterCursor: "c0",
      beforeCursor: undefined,
      limit: 20,
    })
    expect(fake.calls[1]?.options.query).toMatchObject({
      direction: "backward",
      beforeCursor: "c9",
    })
  })
})

describe("log transport", () => {
  let originalWebSocket: typeof WebSocket

  beforeEach(() => {
    originalWebSocket = globalThis.WebSocket
    FakeWebSocket.instances = []
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
  })

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket
  })

  test("uses the configured API origin and resumes batched frames with cookie auth", async () => {
    const fake = fakeClient()
    const received: SixbLogLine[] = []
    const unsubscribe = logs
      .workflows({ client: fake.client })
      .run("wf-1")
      .level("warn")
      .subscribe((entry) => received.push(entry), { reconnectDelayMs: 1 })

    await tick()
    const first = FakeWebSocket.instances[0]
    if (!first) throw new Error("expected a websocket")
    expect(first.url).toBe("wss://api.example.test/ws/logs")
    expect(first.protocols).toBeUndefined()
    first.onopen?.()
    expect(JSON.parse(first.sent[0])).toEqual({
      type: "subscribe",
      kinds: ["workflow"],
      levels: ["warn", "error"],
      run: { kind: "workflow", id: "wf-1" },
    })

    first.onmessage?.({
      data: JSON.stringify({ type: "logs", logs: [line("c1", "one"), line("c2", "two")] }),
    })
    expect(received.map((entry) => entry.message)).toEqual(["one", "two"])

    first.onclose?.()
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = FakeWebSocket.instances[1]
    if (!second) throw new Error("expected a reconnect")
    expect(second.protocols).toBeUndefined()
    second.onopen?.()
    expect(JSON.parse(second.sent[0]).afterCursor).toBe("c2")

    unsubscribe()
  })

  test("validates batched and reset frames", () => {
    expect(parseLogStreamMessage(JSON.stringify({ type: "logs", logs: [line("c1")] }))).toEqual({
      type: "logs",
      logs: [line("c1")],
    })
    expect(
      parseLogStreamMessage(
        JSON.stringify({ type: "reset", reason: "cursor_expired", cursor: "c9" })
      )
    ).toEqual({ type: "reset", reason: "cursor_expired", cursor: "c9" })
    expect(parseLogStreamMessage(JSON.stringify({ type: "logs", logs: [{}] }))).toBeNull()

    const valid = line("c1")
    for (const invalid of [
      { ...valid, level: "fatal" },
      { ...valid, fields: [] },
      { ...valid, context: { ...valid.context, run: { kind: "dataset", id: "ds-1" } } },
      { ...valid, context: { ...valid.context, attempt: "1" } },
    ]) {
      expect(parseLogStreamMessage(JSON.stringify({ type: "logs", logs: [invalid] }))).toBeNull()
    }
  })
})
