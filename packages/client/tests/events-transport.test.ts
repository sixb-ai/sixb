import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { SixbEvent } from "../src/events"
import { createEventSocket } from "../src/events-transport"

function telemetryEvent(cursor: string): SixbEvent {
  return {
    id: "evt-1",
    cursor,
    projectId: "proj",
    occurredAt: "2026-01-01T00:00:00.000Z",
    type: "telemetry.appended",
    topic: "telemetry",
    partitionKey: "device:fan-1:rpm",
    payload: {
      objectTypeId: "device",
      objectId: "fan-1",
      propertyId: "rpm",
      value: 1,
      at: "2026-01-01T00:00:00.000Z",
    },
  } as SixbEvent
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  readonly sent: string[] = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null

  constructor(readonly url: string) {
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

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for websocket state.")
    }
    await tick(1)
  }
}

describe("createEventSocket", () => {
  let originalWebSocket: typeof WebSocket
  let activeSocket: ReturnType<typeof createEventSocket> | null

  beforeEach(() => {
    originalWebSocket = globalThis.WebSocket
    activeSocket = null
    FakeWebSocket.instances = []
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
  })

  afterEach(() => {
    activeSocket?.close()
    globalThis.WebSocket = originalWebSocket
  })

  test("reconnects after the socket closes and resumes from the last cursor", async () => {
    const received: SixbEvent[] = []
    const socket = createEventSocket({
      topic: "telemetry",
      reconnect: true,
      reconnectDelayMs: 1,
      onEvent: (event) => received.push(event),
    })
    activeSocket = socket

    const ws1 = FakeWebSocket.instances[0]
    if (!ws1) throw new Error("expected a websocket")
    ws1.onopen?.()
    expect(ws1.sent).toHaveLength(0)
    ws1.onmessage?.({ data: JSON.stringify({ type: "connected" }) })
    expect(JSON.parse(ws1.sent[0]).afterCursor).toBeUndefined()
    ws1.onmessage?.({ data: JSON.stringify({ type: "subscribed" }) })

    ws1.onmessage?.({ data: JSON.stringify({ type: "event", event: telemetryEvent("c5") }) })
    expect(received).toHaveLength(1)

    // The server drops the connection; the socket should reconnect on its own.
    ws1.onclose?.()
    await tick()

    const ws2 = FakeWebSocket.instances[1]
    if (!ws2) throw new Error("expected a reconnect")
    ws2.onopen?.()
    expect(ws2.sent).toHaveLength(0)
    ws2.onmessage?.({ data: JSON.stringify({ type: "connected" }) })
    // The resubscribe resumes after the last delivered cursor — no replay, no gap.
    expect(JSON.parse(ws2.sent[0]).afterCursor).toBe("c5")

    socket.close()
  })

  test("subscribes once after the event server announces readiness", () => {
    const socket = createEventSocket({
      topic: "telemetry",
      reconnect: false,
      onEvent: () => {},
    })
    activeSocket = socket

    const ws = FakeWebSocket.instances[0]
    if (!ws) throw new Error("expected a websocket")
    ws.onopen?.()
    expect(ws.sent).toHaveLength(0)

    ws.onmessage?.({ data: JSON.stringify({ type: "connected", channel: "events" }) })
    ws.onmessage?.({ data: JSON.stringify({ type: "connected", channel: "events" }) })

    expect(ws.sent).toHaveLength(1)
    expect(JSON.parse(ws.sent[0])).toMatchObject({
      type: "subscribe",
      topic: "telemetry",
    })
    socket.close()
  })

  test("reports connected only after the server acknowledges the subscription", () => {
    const states: { connected: boolean }[] = []
    const socket = createEventSocket({
      topic: "telemetry",
      reconnect: false,
      onEvent: () => {},
      onStateChange: (state) => states.push(state),
    })
    activeSocket = socket

    const ws = FakeWebSocket.instances[0]
    if (!ws) throw new Error("expected a websocket")

    ws.onopen?.()
    expect(states.at(-1)).toMatchObject({ connected: false })

    ws.onmessage?.({ data: JSON.stringify({ type: "connected", channel: "events" }) })
    expect(ws.sent).toHaveLength(1)
    expect(states.at(-1)).toMatchObject({ connected: false })

    ws.onmessage?.({ data: JSON.stringify({ type: "subscribed" }) })
    expect(states.at(-1)).toMatchObject({ connected: true })

    socket.close()
  })

  test("closes and reconnects when the protocol handshake times out", async () => {
    const errors: string[] = []
    const socket = createEventSocket({
      reconnect: true,
      reconnectDelayMs: 1,
      handshakeTimeoutMs: 5,
      onEvent: () => {},
      onError: (message) => errors.push(message),
    })
    activeSocket = socket

    const ws1 = FakeWebSocket.instances[0]
    if (!ws1) throw new Error("expected a websocket")
    ws1.onopen?.()
    await waitFor(() => ws1.closed)
    await waitFor(() => FakeWebSocket.instances.length === 2)

    expect(errors).toEqual(["Event websocket handshake timed out."])

    socket.close()
  })

  test("does not reconnect when reconnect is disabled", async () => {
    const socket = createEventSocket({
      topic: "telemetry",
      reconnect: false,
      reconnectDelayMs: 1,
      onEvent: () => {},
    })
    activeSocket = socket

    const ws1 = FakeWebSocket.instances[0]
    if (!ws1) throw new Error("expected a websocket")
    ws1.onopen?.()
    ws1.onclose?.()
    await tick(10)

    expect(FakeWebSocket.instances).toHaveLength(1)
    socket.close()
  })

  test("stops reconnecting once closed", async () => {
    const socket = createEventSocket({
      topic: "telemetry",
      reconnect: true,
      reconnectDelayMs: 1,
      onEvent: () => {},
    })
    activeSocket = socket

    const ws1 = FakeWebSocket.instances[0]
    if (!ws1) throw new Error("expected a websocket")
    ws1.onopen?.()

    socket.close()
    ws1.onclose?.()
    await tick()

    expect(FakeWebSocket.instances).toHaveLength(1)
  })
})
