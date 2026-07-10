import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { defineObjectType, prop } from "@sixb/core/ontology"
import type { SixbEvent } from "../src/events"
import { events } from "../src/events-builder"
import { createEventsRegistry } from "../src/events-provider"

const Device = defineObjectType({
  id: "device",
  name: "Device",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("rpm", "integer", { mode: "telemetry" }),
  ],
})

const Sensor = defineObjectType({
  id: "sensor",
  name: "Sensor",
  properties: [prop("id", "string", { required: true, primary: true })],
})

function telemetryEvent(objectTypeId: string, objectId: string, cursor = "c1"): SixbEvent {
  return {
    id: "evt-1",
    cursor,
    projectId: "proj",
    occurredAt: "2026-01-01T00:00:00.000Z",
    type: "telemetry.appended",
    topic: "telemetry",
    partitionKey: `${objectTypeId}:${objectId}:rpm`,
    payload: {
      objectTypeId,
      objectId,
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

  constructor() {
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

function deliver(ws: FakeWebSocket, event: SixbEvent): void {
  ws.onmessage?.({ data: JSON.stringify({ type: "event", event }) })
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))

describe("createEventsRegistry", () => {
  let originalWebSocket: typeof WebSocket

  beforeEach(() => {
    originalWebSocket = globalThis.WebSocket
    FakeWebSocket.instances = []
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
  })

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket
  })

  test("shares one socket and closes it after the last unregister", async () => {
    const registry = createEventsRegistry({ closeDelayMs: 0 })

    const off1 = registry.register(events(Device).telemetry().ir, () => {})
    expect(FakeWebSocket.instances).toHaveLength(1)

    const off2 = registry.register(events(Sensor).telemetry().ir, () => {})
    expect(FakeWebSocket.instances).toHaveLength(1)

    const ws = FakeWebSocket.instances[0]
    if (!ws) throw new Error("expected a websocket")

    off1()
    expect(ws.closed).toBe(false)
    off2()
    // Teardown is deferred so a quick remount can reuse the socket.
    expect(ws.closed).toBe(false)
    await tick()
    expect(ws.closed).toBe(true)
  })

  test("reuses the socket when a subscriber re-registers within the close window", async () => {
    const registry = createEventsRegistry({ closeDelayMs: 50 })

    const off = registry.register(events(Device).telemetry().ir, () => {})
    const ws = FakeWebSocket.instances[0]
    if (!ws) throw new Error("expected a websocket")

    off()
    // Re-register before the pending close fires.
    registry.register(events(Sensor).telemetry().ir, () => {})
    await tick(80)

    expect(ws.closed).toBe(false)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  test("resumes from the last cursor after a true close then reopen", async () => {
    const registry = createEventsRegistry({ closeDelayMs: 0 })

    const off = registry.register(events(Device).telemetry().ir, () => {})
    const ws1 = FakeWebSocket.instances[0]
    if (!ws1) throw new Error("expected a websocket")
    ws1.onopen?.()
    ws1.onmessage?.({ data: JSON.stringify({ type: "connected" }) })
    deliver(ws1, telemetryEvent("device", "fan-1", "c9"))

    off()
    await tick()
    expect(ws1.closed).toBe(true)

    registry.register(events(Sensor).telemetry().ir, () => {})
    const ws2 = FakeWebSocket.instances[1]
    if (!ws2) throw new Error("expected a reopen")
    ws2.onopen?.()
    ws2.onmessage?.({ data: JSON.stringify({ type: "connected" }) })
    expect(JSON.parse(ws2.sent[0]).afterCursor).toBe("c9")
  })

  test("broadcasts socket errors to every subscriber", () => {
    const registry = createEventsRegistry()
    const errors1: string[] = []
    const errors2: string[] = []

    registry.register(events(Device).telemetry().ir, () => {}, {
      onError: (message) => errors1.push(message),
    })
    registry.register(events(Sensor).telemetry().ir, () => {}, {
      onError: (message) => errors2.push(message),
    })

    const ws = FakeWebSocket.instances[0]
    if (!ws) throw new Error("expected a websocket")
    ws.onopen?.()
    ws.onerror?.()

    expect(errors1).toEqual(["Event websocket connection failed."])
    expect(errors2).toEqual(["Event websocket connection failed."])
  })

  test("fans each event only to subscribers whose filter matches", () => {
    const registry = createEventsRegistry()
    const deviceEvents: SixbEvent[] = []
    const sensorEvents: SixbEvent[] = []

    registry.register(events(Device).telemetry().ir, (event) => deviceEvents.push(event))
    registry.register(events(Sensor).telemetry().ir, (event) => sensorEvents.push(event))

    const ws = FakeWebSocket.instances[0]
    if (!ws) throw new Error("expected a websocket")
    ws.onopen?.()

    deliver(ws, telemetryEvent("device", "fan-1"))
    expect(deviceEvents).toHaveLength(1)
    expect(sensorEvents).toHaveLength(0)

    deliver(ws, telemetryEvent("sensor", "probe-1"))
    expect(deviceEvents).toHaveLength(1)
    expect(sensorEvents).toHaveLength(1)
  })

  test("syncs a late subscriber to the current connection state", () => {
    const registry = createEventsRegistry()
    registry.register(events(Device).telemetry().ir, () => {})

    const ws = FakeWebSocket.instances[0]
    if (!ws) throw new Error("expected a websocket")
    ws.onopen?.()

    const states: { connected: boolean }[] = []
    registry.register(events(Sensor).telemetry().ir, () => {}, {
      onStateChange: (state) => states.push(state),
    })

    expect(states.at(-1)).toMatchObject({ connected: true })
  })
})
