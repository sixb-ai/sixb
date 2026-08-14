// Typecheck-only proof for the `events.object(Type)` builder: channels must narrow the
// event AND type the payload from the ontology, wrong-channel access must error,
// and `.upserted()` on a wide object type must survive `Object.entries().map()`
// WITHOUT tripping TS2589 — the recursion-prone path real components hit.
// Checked by `cd packages/client && bun run typecheck` (tests are in the program).
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
import { events } from "../src/events-builder"
import { useEvents, useInvalidateOnEvent, useLatest, useLatestByObject } from "../src/events-hooks"

const Zone = defineObjectType({
  id: "Zone",
  name: "Zone",
  properties: [prop("label", "string", { required: true })],
})

const Sensor = defineObjectType({
  id: "Sensor",
  name: "Sensor",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
    prop("indoorTemperature", "double", { mode: "telemetry", semanticType: "Temperature" }),
    prop("online", "boolean", { mode: "telemetry" }),
  ],
  links: [link.ref("zone", "Zone", { cardinality: "one", properties: [prop("rank", "integer")] })],
})

const sensorOffline = defineRule("sensor.offline")
  .on(Sensor)
  .where((sensor) => sensor.p.name.eq("offline"))

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

// @ts-expect-error event categories are explicit; the facade is not callable
events(Sensor)

// @ts-expect-error object instances are selected with .byId(), not .object()
events.object(Sensor).object("sensor-1")

// ── Channels narrow the payload ───────────────────────────────────────────────

// `.telemetry(token)` → the property's ontology-typed value.
events
  .object(Sensor)
  .telemetry(Sensor.p.indoorTemperature)
  .subscribe((event) => {
    const value: number = event.payload.value
    void value
  })

events
  .rule(sensorOffline)
  .triggered()
  .subscribe((event) => {
    const ruleId: string = event.payload.ruleId
    void ruleId
  })

function useActionEventsTypeProof() {
  useEvents(events.action(acknowledgeSensor).completed(), (event) => {
    const actionId: string = event.payload.actionId
    const runId: string = event.payload.runId
    void [actionId, runId]
  })
}

void useActionEventsTypeProof

function useRunEventsTypeProof() {
  useEvents(events.dataset(readings).updated(), (event) => {
    const datasetId: "sensor.readings" = event.payload.datasetId
    void datasetId
  })
  useEvents(events.sync(importReadings).succeeded(), (event) => {
    const syncId: "import-readings" = event.payload.syncId
    const status: "succeeded" = event.payload.status
    void [syncId, status]
  })
  useEvents(events.pipeline(normalizeReadings).failed(), (event) => {
    const pipelineId: "normalize-readings" = event.payload.pipelineId
    const status: "failed" = event.payload.status
    void [pipelineId, status]
  })
}

void useRunEventsTypeProof

// `.telemetry(boolean prop)` → boolean value.
events
  .object(Sensor)
  .telemetry(Sensor.p.online)
  .subscribe((event) => {
    const value: boolean = event.payload.value
    void value
  })

// `.telemetry()` with no token → untyped value.
events
  .object(Sensor)
  .telemetry()
  .subscribe((event) => {
    const value: unknown = event.payload.value
    // @ts-expect-error — an untyped telemetry value is `unknown`, not `number`.
    const narrowed: number = event.payload.value
    void [value, narrowed]
  })

// `.upserted()` → ontology-typed `payload.properties`.
events
  .object(Sensor)
  .upserted()
  .subscribe((event) => {
    const name: string = event.payload.properties.name
    void name
    // @ts-expect-error — `missing` is not a property of Sensor.
    void event.payload.properties.missing
  })

// `.deleted()` → identity payload, no `properties`.
events
  .object(Sensor)
  .deleted()
  .subscribe((event) => {
    const primaryId: string = event.payload.primaryId
    // @ts-expect-error — a delete payload carries no `properties`.
    void event.payload.properties
    void primaryId
  })

events
  .object(Sensor)
  .created()
  .subscribe((event) => {
    const name: string = event.payload.properties.name
    const change = event.payload.propertyChanges.name
    void [name, change]
  })

events
  .object(Sensor)
  .p.name.updated()
  .subscribe((event) => {
    const change = event.payload.propertyChanges.name
    if (change?.operation === "updated") {
      const before: unknown = change.before
      const after: unknown = change.after
      void [before, after]
    }
  })

// `.link(token)` validates the token against the type's links and yields the
// canonical link event union until a terminal operation narrows it.
events
  .object(Sensor)
  .link(Sensor.l.zone)
  .subscribe((event) => {
    const linkId: string = event.payload.linkId
    const sourceId: string = event.payload.sourceId
    void [linkId, sourceId]
  })

events
  .object(Sensor)
  .link(Sensor.l.zone)
  .created()
  .subscribe((event) => {
    const linkId: string = event.payload.linkId
    const change = event.payload.propertyChanges.rank
    void [linkId, change]
  })

events
  .object(Sensor)
  .link(Sensor.l.zone)
  .p.rank.updated()
  .subscribe((event) => {
    const change = event.payload.propertyChanges.rank
    void change
  })

// @ts-expect-error — `.linked` was removed; use `.link(token)`.
events.object(Sensor).linked(Sensor.l.zone)

// @ts-expect-error — `.link` requires a link token, not a property token.
events.object(Sensor).link(Sensor.p.indoorTemperature)

// @ts-expect-error — missing object property.
events.object(Sensor).p.missing

// @ts-expect-error — missing link property.
events.object(Sensor).link(Sensor.l.zone).p.missing

// `.byId(key)` is orthogonal — it preserves the channel's event type, in
// either order.
events
  .object(Sensor)
  .byId("sensor-1")
  .telemetry(Sensor.p.indoorTemperature)
  .subscribe((event) => {
    const value: number = event.payload.value
    void value
  })
events
  .object(Sensor)
  .telemetry(Sensor.p.indoorTemperature)
  .byId("sensor-1")
  .subscribe((event) => {
    const value: number = event.payload.value
    void value
  })

// ── Wrong-channel / wrong-token access is rejected ────────────────────────────

events
  .object(Sensor)
  .telemetry()
  .subscribe((event) => {
    // @ts-expect-error — a telemetry payload has no `properties`.
    void event.payload.properties
  })

// @ts-expect-error — a property token from another object type is rejected.
events.object(Sensor).telemetry(Zone.p.label)

// ── Topic namespace ───────────────────────────────────────────────────────────

events.all().subscribe((event) => {
  const topic: string = event.topic
  void topic
})

events.telemetry().subscribe((event) => {
  const propertyId: string = event.payload.propertyId
  void propertyId
})

// Topic builders can scope to a single instance without importing the type.
events
  .telemetry()
  .byId("sensor-1")
  .subscribe((event) => {
    const value: unknown = event.payload.value
    void value
  })

events
  .workflows()
  .run("run-1")
  .subscribe((event) => {
    const runId: string = event.payload.runId
    if (
      (event.type === "workflow.run.finished" || event.type === "workflow.run.node.finished") &&
      event.payload.error
    ) {
      const code: "internal.unexpected" | "runtime.cancelled" | "workflow.node_failed" =
        event.payload.error.code
      const message: string = event.payload.error.message
      // @ts-expect-error — workflow lifecycle failures expose only their primitive's code union.
      const datasetCode: "dataset.not_found" = event.payload.error.code
      void [code, message, datasetCode]
    }
    void runId
  })

events
  .pipelines()
  .run("run-1")
  .subscribe((event) => {
    if (
      (event.type === "pipeline.run.finished" || event.type === "pipeline.run.step.finished") &&
      event.payload.error
    ) {
      const code: "internal.unexpected" | "runtime.cancelled" | "pipeline.step_failed" =
        event.payload.error.code
      const message: string = event.payload.error.message
      // @ts-expect-error — pipeline lifecycle failures expose only their primitive's code union.
      const datasetCode: "dataset.not_found" = event.payload.error.code
      void [code, message, datasetCode]
    }
  })

events
  .syncs()
  .run("run-1")
  .subscribe((event) => {
    if (event.type === "sync.run.finished" && event.payload.error) {
      const code: "internal.unexpected" | "runtime.cancelled" | "sync.execution_failed" =
        event.payload.error.code
      const message: string = event.payload.error.message
      // @ts-expect-error — sync lifecycle failures expose only their primitive's code union.
      const datasetCode: "dataset.not_found" = event.payload.error.code
      void [code, message, datasetCode]
    }
  })

events
  .actions()
  .run("act-1")
  .action("approveQuote")
  .subject(Sensor)
  .byId("sensor-1")
  .completed()
  .subscribe((event) => {
    const runId: string = event.payload.runId
    const actionId: string = event.payload.actionId
    const finishedAt: string = event.payload.finishedAt
    // @ts-expect-error — completed events do not carry an error payload.
    void event.payload.error
    void [runId, actionId, finishedAt]
  })

events
  .actions()
  .subject("Sensor")
  .byId("sensor-1")
  .failed()
  .subscribe((event) => {
    const code:
      | "internal.unexpected"
      | "runtime.cancelled"
      | "queue.enqueue_failed"
      | "action.phase_failed" = event.payload.error.code
    const message: string = event.payload.error.message
    // @ts-expect-error — Action lifecycle failures expose only their primitive's code union.
    const datasetCode: "dataset.not_found" = event.payload.error.code
    void [code, message, datasetCode]
  })

events
  .actions()
  .terminal()
  .subscribe((event) => {
    if (event.type === "action.failed") {
      const message: string = event.payload.error.message
      void message
    } else {
      const finishedAt: string = event.payload.finishedAt
      void finishedAt
    }
  })

// ── TS2589 stressor: wide object type through `.upserted()` + `.map()` ────────

const WideThing = defineObjectType({
  id: "WideThing",
  name: "Wide Thing",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("a", "double", { mode: "telemetry" }),
    prop("b", "double", { mode: "telemetry" }),
    prop("c", "double", { mode: "telemetry" }),
    prop("d", "integer", { mode: "telemetry" }),
    prop("e", "integer", { mode: "telemetry" }),
    prop("f", "boolean", { mode: "telemetry" }),
    prop("g", "boolean", { mode: "telemetry" }),
    prop("h", "string"),
    prop("i", "string"),
    prop("j", "double", { mode: "telemetry" }),
    prop("k", "double", { mode: "telemetry" }),
  ],
})

events
  .object(WideThing)
  .upserted()
  .subscribe((event) => {
    const summary: string[] = Object.entries(event.payload.properties).map(
      ([key, value]) => `${key}:${String(value)}`
    )
    void summary
  })

// ── Hooks infer the builder's event type ──────────────────────────────────────

function useSensorLive(): void {
  useEvents(events.object(Sensor).telemetry(Sensor.p.indoorTemperature), (event) => {
    const value: number = event.payload.value
    void value
  })

  useEvents(events.object(Sensor).p.name.updated(), (event) => {
    const change = event.payload.propertyChanges.name
    void change
  })

  const { values } = useLatest(events.object(Sensor).byId("sensor-1").telemetry())
  const reading: number | string | boolean | undefined = values.indoorTemperature?.value
  void reading

  const { byObject } = useLatestByObject(events.object(Sensor).telemetry())
  void byObject

  useInvalidateOnEvent(events.workflows(), (event) => [["workflow", event.payload.runId]], {
    debounceMs: 100,
  })
}
void useSensorLive
