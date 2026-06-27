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

function telemetryEvent(objectTypeId: string, objectId: string): SixbEvent {
  return {
    id: "evt-1",
    cursor: "c1",
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

  test("shares one socket and closes it on the last unregister", () => {
    const registry = createEventsRegistry()

    const off1 = registry.register(events(Device).telemetry().ir, () => {})
    expect(FakeWebSocket.instances).toHaveLength(1)

    const off2 = registry.register(events(Sensor).telemetry().ir, () => {})
    expect(FakeWebSocket.instances).toHaveLength(1)

    const ws = FakeWebSocket.instances[0]
    if (!ws) throw new Error("expected a websocket")

    off1()
    expect(ws.closed).toBe(false)
    off2()
    expect(ws.closed).toBe(true)
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
