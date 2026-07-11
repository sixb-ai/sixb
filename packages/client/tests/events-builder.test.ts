import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  col,
  defineAction,
  defineConnector,
  defineDataset,
  definePipeline,
  defineRule,
  defineSync,
  param,
} from "@sixb/core"
import { defineObjectType, link, prop } from "@sixb/core/ontology"
import type { SixbEvent } from "../src/events"
import { buildEventPredicate, events } from "../src/events-builder"
import { telemetryUpdateFromEvent } from "../src/telemetry-events"

const Sensor = defineObjectType({
  id: "Sensor",
  name: "Sensor",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("status", "string"),
    prop("indoorTemperature", "double", { mode: "telemetry", semanticType: "Temperature" }),
  ],
  links: [link.ref("zone", "Zone", { cardinality: "one", properties: [prop("rank", "integer")] })],
})

const sensorOffline = defineRule("sensor.offline")
  .on(Sensor)
  .where((sensor) => sensor.p.status.eq("offline"))

const acknowledgeSensor = defineAction("acknowledge-sensor")
  .on(Sensor)
  .params({ note: param("string") })
  .writeback(async () => {})

const readings = defineDataset("sensor.readings", { schema: [col("id", "string")] })
const source = defineConnector("sensor-source", { type: "test", connect: () => ({}) })
const importReadings = defineSync("import-readings")
  .from(source)
  .read(() => [])
  .intoDataset(readings)
const normalizeReadings = definePipeline("normalize-readings")

// A loose fixture builder: tests provide ad-hoc per-topic payloads, so the
// override bag is intentionally untyped and cast to `SixbEvent` on the way out.
function event(overrides: { type: string; topic: string } & Record<string, unknown>): SixbEvent {
  return {
    id: "evt-1",
    cursor: "c1",
    projectId: "proj",
    occurredAt: "2026-01-01T00:00:00.000Z",
    partitionKey: "pk",
    payload: {},
    ...overrides,
  } as SixbEvent
}

const telemetryEvent = event({
  type: "telemetry.appended",
  topic: "telemetry",
  partitionKey: "Sensor:sensor-1:indoorTemperature",
  payload: {
    objectTypeId: "Sensor",
    objectId: "sensor-1",
    propertyId: "indoorTemperature",
    value: 21.5,
    unit: "celsius",
    at: "2026-01-01T00:00:00.000Z",
  },
})

describe("events builder filter spec", () => {
  test("events.object(Type) seeds the object type id", () => {
    expect(events.object(Sensor).ir).toEqual({ objectTypeId: "Sensor" })
  })

  test("telemetry(token) narrows topic, types and property", () => {
    expect(events.object(Sensor).telemetry(Sensor.p.indoorTemperature).ir).toEqual({
      objectTypeId: "Sensor",
      topic: "telemetry",
      types: ["telemetry.appended"],
      propertyId: "indoorTemperature",
    })
  })

  test("byId(key) is orthogonal to the channel", () => {
    expect(events.object(Sensor).byId("sensor-1").telemetry().ir).toEqual({
      objectTypeId: "Sensor",
      primaryId: "sensor-1",
      topic: "telemetry",
      types: ["telemetry.appended"],
    })
  })

  test("upserted / deleted / linked set their types", () => {
    expect(events.object(Sensor).upserted().ir.types).toEqual(["object.upserted"])
    expect(events.object(Sensor).deleted().ir).toMatchObject({
      topic: "objects",
      types: ["object.deleted"],
    })
    expect(events.object(Sensor).linked(Sensor.l.zone).ir).toMatchObject({
      topic: "links",
      types: ["link.upserted", "link.removed"],
      linkId: "zone",
    })
  })

  test("created / updated / property / link selectors use mutation facts", () => {
    expect(events.object(Sensor).created().ir).toMatchObject({
      topic: "objects",
      types: ["object.created"],
    })
    expect(events.object(Sensor).p.status.updated().ir).toMatchObject({
      topic: "objects",
      types: ["object.updated"],
      propertyId: "status",
      propertyOperation: "updated",
    })
    expect(events.object(Sensor).p.status.created().ir).toMatchObject({
      topic: "objects",
      types: ["object.created", "object.updated"],
      propertyId: "status",
      propertyOperation: "created",
    })
    expect(events.object(Sensor).p.status.created().updated().ir).toMatchObject({
      types: ["object.updated"],
      propertyOperation: "updated",
    })
    expect(events.object(Sensor).link(Sensor.l.zone).created().ir).toMatchObject({
      topic: "links",
      types: ["link.created"],
      linkId: "zone",
    })
    expect(events.object(Sensor).link(Sensor.l.zone).p.rank.updated().ir).toMatchObject({
      topic: "links",
      types: ["link.updated"],
      linkId: "zone",
      propertyId: "rank",
      propertyOperation: "updated",
    })
    expect(events.object(Sensor).link(Sensor.l.zone).p.rank.created().ir).toMatchObject({
      topic: "links",
      types: ["link.created", "link.updated"],
      linkId: "zone",
      propertyId: "rank",
      propertyOperation: "created",
    })
  })

  test("the builder is immutable (copy-on-write)", () => {
    const base = events.object(Sensor)
    base.telemetry()
    expect(base.ir).toEqual({ objectTypeId: "Sensor" })
  })

  test("namespace builders", () => {
    expect(events.all().ir).toEqual({})
    expect(events.telemetry().ir).toEqual({ topic: "telemetry" })
    expect(events.workflows().run("run-1").ir).toEqual({ topic: "workflows", runId: "run-1" })
    expect(events.actions().run("act-1").action("approveQuote").terminal().ir).toEqual({
      topic: "actions",
      runId: "act-1",
      actionId: "approveQuote",
      types: ["action.completed", "action.failed"],
    })
    expect(events.actions().subject(Sensor).byId("sensor-1").completed().ir).toEqual({
      topic: "actions",
      objectTypeId: "Sensor",
      primaryId: "sensor-1",
      types: ["action.completed"],
    })
    expect(events.actions().subject("Sensor").byId("sensor-1").failed().ir).toEqual({
      topic: "actions",
      objectTypeId: "Sensor",
      primaryId: "sensor-1",
      types: ["action.failed"],
    })
  })

  test("definition-scoped rule and action builders", () => {
    expect(events.rule(sensorOffline).triggered().ir).toEqual({
      topic: "rules",
      ruleId: "sensor.offline",
      types: ["rule.triggered"],
    })
    expect(events.action(acknowledgeSensor).completed().ir).toEqual({
      topic: "actions",
      actionId: "acknowledge-sensor",
      types: ["action.completed"],
    })
  })

  test("definition-scoped dataset, sync, and pipeline builders", () => {
    expect(events.dataset(readings).updated().ir).toEqual({
      topic: "datasets",
      datasetId: "sensor.readings",
      types: ["dataset.version.committed"],
    })
    expect(events.sync(importReadings).succeeded().ir).toEqual({
      topic: "syncs",
      syncId: "import-readings",
      types: ["sync.run.finished"],
      runStatus: "succeeded",
    })
    expect(events.pipeline(normalizeReadings).cancelled().ir).toEqual({
      topic: "pipelines",
      pipelineId: "normalize-readings",
      types: ["pipeline.run.finished"],
      runStatus: "cancelled",
    })
  })
})

describe("buildEventPredicate", () => {
  test("filters telemetry by objectType, object and property", () => {
    const matches = buildEventPredicate(
      events.object(Sensor).byId("sensor-1").telemetry(Sensor.p.indoorTemperature).ir
    )
    expect(matches(telemetryEvent)).toBe(true)
    expect(matches({ ...telemetryEvent, topic: "objects" } as SixbEvent)).toBe(false)
    expect(
      matches(
        event({ ...telemetryEvent, payload: { ...telemetryEvent.payload, objectId: "other" } })
      )
    ).toBe(false)
    expect(
      matches(
        event({ ...telemetryEvent, payload: { ...telemetryEvent.payload, propertyId: "online" } })
      )
    ).toBe(false)
  })

  test("links match on the source side", () => {
    const matches = buildEventPredicate(
      events.object(Sensor).byId("sensor-1").linked(Sensor.l.zone).ir
    )
    const linkEvent = event({
      type: "link.upserted",
      topic: "links",
      payload: {
        sourceTypeId: "Sensor",
        sourceId: "sensor-1",
        linkId: "zone",
        targetTypeId: "Zone",
        targetId: "zone-1",
      },
    })
    expect(matches(linkEvent)).toBe(true)
    expect(
      matches(event({ ...linkEvent, payload: { ...linkEvent.payload, linkId: "other" } }))
    ).toBe(false)
  })

  test("property selectors match propertyChanges", () => {
    const matches = buildEventPredicate(events.object(Sensor).p.status.updated().ir)
    const changed = event({
      type: "object.updated",
      topic: "objects",
      payload: {
        objectTypeId: "Sensor",
        primaryId: "sensor-1",
        properties: { status: "online" },
        propertyChanges: {
          status: { operation: "updated", before: "offline", after: "online" },
        },
      },
    })

    expect(matches(changed)).toBe(true)
    expect(
      matches(
        event({
          ...changed,
          payload: {
            ...changed.payload,
            propertyChanges: {
              status: { operation: "created", after: "online" },
            },
          },
        })
      )
    ).toBe(false)
  })

  test("run scope matches payload.runId", () => {
    const matches = buildEventPredicate(events.workflows().run("run-1").ir)
    const wfEvent = event({
      type: "workflow.run.started",
      topic: "workflows",
      payload: { workflowId: "wf-1", runId: "run-1" },
    })
    expect(matches(wfEvent)).toBe(true)
    expect(matches(event({ ...wfEvent, payload: { workflowId: "wf-1", runId: "run-2" } }))).toBe(
      false
    )
  })

  test("actions match run, action id and object subject scope", () => {
    const matches = buildEventPredicate(
      events.actions().run("act-1").action("approveQuote").subject(Sensor).byId("sensor-1").ir
    )
    const actionCompleted = event({
      type: "action.completed",
      topic: "actions",
      payload: {
        actionId: "approveQuote",
        runId: "act-1",
        subject: { kind: "object", objectTypeId: "Sensor", primaryId: "sensor-1" },
        finishedAt: "2026-01-01T00:00:00.000Z",
      },
    })
    expect(matches(actionCompleted)).toBe(true)
    expect(
      matches(
        event({ ...actionCompleted, payload: { ...actionCompleted.payload, runId: "act-2" } })
      )
    ).toBe(false)
    expect(
      matches(
        event({
          ...actionCompleted,
          payload: { ...actionCompleted.payload, actionId: "rejectQuote" },
        })
      )
    ).toBe(false)
    expect(
      matches(
        event({
          ...actionCompleted,
          payload: {
            ...actionCompleted.payload,
            subject: { kind: "object", objectTypeId: "Sensor", primaryId: "sensor-2" },
          },
        })
      )
    ).toBe(false)
  })

  test("an empty filter matches everything", () => {
    const matches = buildEventPredicate(events.all().ir)
    expect(matches(telemetryEvent)).toBe(true)
  })
})

describe("telemetryUpdateFromEvent", () => {
  test("maps the appended payload field-by-field", () => {
    expect(telemetryUpdateFromEvent(telemetryEvent as never)).toEqual({
      type: "telemetryUpdate",
      projectId: "proj",
      projectName: "proj",
      objectTypeId: "Sensor",
      objectId: "sensor-1",
      propertyId: "indoorTemperature",
      value: 21.5,
      timestamp: "2026-01-01T00:00:00.000Z",
      quality: "good",
      unit: "celsius",
    })
  })

  test("normalizes non-primitive values to JSON", () => {
    const update = telemetryUpdateFromEvent(
      event({
        type: "telemetry.appended",
        topic: "telemetry",
        payload: { objectTypeId: "S", objectId: "o", propertyId: "p", value: { a: 1 }, at: "t" },
      }) as never
    )
    expect(update.value).toBe('{"a":1}')
  })
})

// ── Transport: drive the builder's `.subscribe()` against a fake WebSocket ─────

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  readonly url: string
  readonly sent: string[] = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null

  constructor(url: string) {
    this.url = url
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

describe("builder subscribe over the transport", () => {
  let originalWebSocket: typeof WebSocket

  beforeEach(() => {
    originalWebSocket = globalThis.WebSocket
    FakeWebSocket.instances = []
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
  })

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket
  })

  test("sends a scoped subscribe message and delivers only matching events", () => {
    const received: SixbEvent[] = []
    const unsubscribe = events
      .object(Sensor)
      .byId("sensor-1")
      .telemetry(Sensor.p.indoorTemperature)
      .subscribe((event) => received.push(event))

    const ws = FakeWebSocket.instances.at(-1)
    if (!ws) throw new Error("expected a websocket")

    ws.onopen?.()
    ws.onmessage?.({ data: JSON.stringify({ type: "connected" }) })
    const subscribeMessage = JSON.parse(ws.sent[0])
    expect(subscribeMessage).toMatchObject({
      type: "subscribe",
      topic: "telemetry",
      // Object scope is pushed to the server.
      objectTypeId: "Sensor",
      primaryId: "sensor-1",
    })
    expect(subscribeMessage.types).toEqual(["telemetry.appended"])
    // The property scope stays client-side; the predicate refines it.
    expect(subscribeMessage.propertyId).toBeUndefined()

    ws.onmessage?.({ data: JSON.stringify({ type: "event", event: telemetryEvent }) })
    expect(received).toHaveLength(1)

    ws.onmessage?.({
      data: JSON.stringify({
        type: "event",
        event: { ...telemetryEvent, payload: { ...telemetryEvent.payload, objectId: "other" } },
      }),
    })
    expect(received).toHaveLength(1)

    unsubscribe()
    expect(ws.closed).toBe(true)
  })

  test("sends action run, action id and subject scope to the server", () => {
    const unsubscribe = events
      .actions()
      .run("act-1")
      .action("approveQuote")
      .subject(Sensor)
      .byId("sensor-1")
      .terminal()
      .subscribe(() => undefined)

    const ws = FakeWebSocket.instances.at(-1)
    if (!ws) throw new Error("expected a websocket")

    ws.onopen?.()
    ws.onmessage?.({ data: JSON.stringify({ type: "connected" }) })
    expect(JSON.parse(ws.sent[0])).toMatchObject({
      type: "subscribe",
      topic: "actions",
      types: ["action.completed", "action.failed"],
      runId: "act-1",
      actionId: "approveQuote",
      objectTypeId: "Sensor",
      primaryId: "sensor-1",
    })

    unsubscribe()
    expect(ws.closed).toBe(true)
  })
})
