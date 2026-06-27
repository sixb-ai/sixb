// Typecheck-only proof for the `events(Type)` builder: channels must narrow the
// event AND type the payload from the ontology, wrong-channel access must error,
// and `.upserted()` on a wide object type must survive `Object.entries().map()`
// WITHOUT tripping TS2589 — the recursion-prone path real components hit.
// Checked by `cd packages/client && bun run typecheck` (tests are in the program).
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
  links: [link.ref("zone", "Zone", { cardinality: "one" })],
})

// ── Channels narrow the payload ───────────────────────────────────────────────

// `.telemetry(token)` → the property's ontology-typed value.
events(Sensor)
  .telemetry(Sensor.p.indoorTemperature)
  .subscribe((event) => {
    const value: number = event.payload.value
    void value
  })

// `.telemetry(boolean prop)` → boolean value.
events(Sensor)
  .telemetry(Sensor.p.online)
  .subscribe((event) => {
    const value: boolean = event.payload.value
    void value
  })

// `.telemetry()` with no token → untyped value.
events(Sensor)
  .telemetry()
  .subscribe((event) => {
    const value: unknown = event.payload.value
    // @ts-expect-error — an untyped telemetry value is `unknown`, not `number`.
    const narrowed: number = event.payload.value
    void [value, narrowed]
  })

// `.upserted()` → ontology-typed `payload.properties`.
events(Sensor)
  .upserted()
  .subscribe((event) => {
    const name: string = event.payload.properties.name
    void name
    // @ts-expect-error — `missing` is not a property of Sensor.
    void event.payload.properties.missing
  })

// `.deleted()` → identity payload, no `properties`.
events(Sensor)
  .deleted()
  .subscribe((event) => {
    const primaryId: string = event.payload.primaryId
    // @ts-expect-error — a delete payload carries no `properties`.
    void event.payload.properties
    void primaryId
  })

// `.linked(token)` validates the token against the type's links and yields the
// links event. The token does NOT narrow the payload — every link event shares
// the same shape — so this asserts the event type, not a per-link payload.
events(Sensor)
  .linked(Sensor.l.zone)
  .subscribe((event) => {
    const linkId: string = event.payload.linkId
    const sourceId: string = event.payload.sourceId
    void [linkId, sourceId]
  })

// @ts-expect-error — `.linked` requires a link token, not a property token.
events(Sensor).linked(Sensor.p.indoorTemperature)

// `.object(key)` is orthogonal — it preserves the channel's event type, in
// either order.
events(Sensor)
  .object("sensor-1")
  .telemetry(Sensor.p.indoorTemperature)
  .subscribe((event) => {
    const value: number = event.payload.value
    void value
  })
events(Sensor)
  .telemetry(Sensor.p.indoorTemperature)
  .object("sensor-1")
  .subscribe((event) => {
    const value: number = event.payload.value
    void value
  })

// ── Wrong-channel / wrong-token access is rejected ────────────────────────────

events(Sensor)
  .telemetry()
  .subscribe((event) => {
    // @ts-expect-error — a telemetry payload has no `properties`.
    void event.payload.properties
  })

// @ts-expect-error — a property token from another object type is rejected.
events(Sensor).telemetry(Zone.p.label)

// ── Topic namespace ───────────────────────────────────────────────────────────

events.all().subscribe((event) => {
  const topic: string = event.topic
  void topic
})

events.telemetry().subscribe((event) => {
  const propertyId: string = event.payload.propertyId
  void propertyId
})

events
  .workflows()
  .run("run-1")
  .subscribe((event) => {
    const runId: string = event.payload.runId
    void runId
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

events(WideThing)
  .upserted()
  .subscribe((event) => {
    const summary: string[] = Object.entries(event.payload.properties).map(
      ([key, value]) => `${key}:${String(value)}`
    )
    void summary
  })

// ── Hooks infer the builder's event type ──────────────────────────────────────

function useSensorLive(): void {
  useEvents(events(Sensor).telemetry(Sensor.p.indoorTemperature), (event) => {
    const value: number = event.payload.value
    void value
  })

  const { values } = useLatest(events(Sensor).object("sensor-1").telemetry())
  const reading: number | string | boolean | undefined = values.indoorTemperature?.value
  void reading

  const { byObject } = useLatestByObject(events(Sensor).telemetry())
  void byObject

  useInvalidateOnEvent(events.workflows(), (event) => [["workflow", event.payload.runId]], {
    debounceMs: 100,
  })
}
void useSensorLive
