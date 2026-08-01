# Telemetry

Telemetry stores a property's value over time. Reach for it when history matters — a project's
progress over its life, a department's headcount month to month, any reading or counter you want
to keep the full series of, not just the current value.

A telemetry property keeps every point you append, and the object record always reflects the
latest one.

## Declare a telemetry property

Set `mode: "telemetry"` on a property in the [ontology](../ontology/properties.md). Without it, a
property is `"static"`: a single fact on the object record.

```ts
import { defineObjectType, prop, stringEnum } from "@sixb/core/ontology"

export const Project = defineObjectType({
  id: "Project",
  name: "Project",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
    prop("status", stringEnum(["draft", "active", "paused", "completed", "cancelled"])),
    prop("progress", "integer", { mode: "telemetry" }),
  ],
})
```

`progress` is a plain `integer` counter — no unit, no semantic type. If a reading represents a
physical quantity (a temperature, a pressure), add a `semanticType` so every point carries a unit;
see [units and semantics](../ontology/units-and-semantics.md). Money is never telemetry-with-units
— model it as `amount` (double) plus a `currency` enum.

Telemetry properties cannot use the `"fileRef"` schema.

## Append a point

Reach a single object with `.byId(id)`, select the telemetry property with the typed token
`Type.p.<name>`, and call `.append(...)`.

```ts
import { Project } from "./ontology/project"

await sixb.objects(Project).byId("proj-001").telemetry(Project.p.progress).append({
  value: 45,
  at: new Date(),
})
```

`append(...)` takes:

| Field | Required | Meaning |
| --- | --- | --- |
| `value` | Yes | The reading. Validated against the property schema. |
| `at` | Yes | The instant of the reading, as a `Date`. |
| `unit` | When the property has a `semanticType` | A valid unit id for the property's quantitative type. |

The object must already exist — appending to a missing object throws. The property must be
telemetry mode and the token must belong to the object type; both are checked before the write.

A property with no `semanticType` rejects a `unit`. A property with one requires it, and the unit
must belong to its family. See [units and semantics](../ontology/units-and-semantics.md).

## Append in batch

`appendTelemetryBatch` writes many points across many objects of one type in a single call. Pass
the bare value, or wrap it as `{ value, unit }` when the property carries a unit.

```ts
await sixb.objects(Department).appendTelemetryBatch([
  {
    id: "dept-eng",
    properties: { headcount: 42 },
  },
  {
    id: "dept-sales",
    properties: { headcount: 17 },
    at: new Date("2026-06-23T12:00:00Z"),
  },
])
```

Each item accepts:

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | Yes | Primary id of an existing object of this type. |
| `properties` | Yes | Map of telemetry property id to a value, or `{ value, unit }`. |
| `at` | No | Instant for every property in the item. Defaults to now. |

Every value is validated and every required unit is checked before any point is written. To record
points from table data instead of code, use a [telemetry projection](../data/projections.md).

## Identity: (series, at)

A telemetry point is uniquely identified by its **series** — the tuple
`(objectType, object, property)` — and its **instant**, `at`. Writing the same instant on the same
series again is a last-write-wins upsert: it updates the value rather than adding a duplicate.

This makes telemetry writes idempotent under replay — re-appending or re-projecting the same
`(series, at)` never produces a second point.

## Read history and latest

The typed channel reads its own series back:

```ts
const progress = sixb.objects(Project).byId("proj-001").telemetry(Project.p.progress)

await progress.append({ value: 42, at: new Date() })
const points = await progress.history({
  from: new Date("2026-06-01T00:00:00Z"),
  to: new Date("2026-06-23T00:00:00Z"),
  limit: 100,
})
```

`history()` returns `{ value, at, unit? }` in chronological order — pass `order: "desc"` for newest
first. The value is typed through the property token, the same way `append` is.

For cross-series reads, or `getLatest`, drop to the time-series store at `sixb.storage.timeseries`:

```ts
const history = await sixb.storage.timeseries.getHistory({
  projectId: sixb.id,
  objectTypeId: "Project",
  objectId: "proj-001",
  propertyId: "progress",
  from: new Date("2026-06-01T00:00:00Z"),
  to: new Date("2026-06-23T00:00:00Z"),
  order: "desc",
  limit: 100,
})

const latest = await sixb.storage.timeseries.getLatest({
  projectId: sixb.id,
  objectTypeId: "Project",
  objectId: "proj-001",
  propertyId: "progress",
})
```

`getHistory` parameters:

| Param | Required | Meaning |
| --- | --- | --- |
| `projectId` | Yes | The project id, usually `sixb.id`. |
| `objectTypeId` | Yes | The object type id. |
| `objectId` | Yes | The object's primary id. |
| `propertyId` | Yes | The telemetry property id. |
| `from` | No | Inclusive lower bound on `at`. |
| `to` | No | Inclusive upper bound on `at`. |
| `order` | No | `"asc"` (default) or `"desc"`. |
| `limit` | No | Maximum number of points to return. |

`getLatest` takes the four identity params and returns the most recent point, or `null` when the
series is empty. Each point has `value`, optional `unit`, `at`, and the four identity fields.

### Over HTTP

The server exposes the same operations as routes on an object:

| Method | Path | Operation |
| --- | --- | --- |
| `POST` | `/api/objects/:objectTypeId/:objectId/telemetry/:propertyId` | Append a point |
| `GET` | `/api/objects/:objectTypeId/:objectId/telemetry/:propertyId/history` | Read history |
| `GET` | `/api/objects/:objectTypeId/:objectId/telemetry/:propertyId/latest` | Read latest point |

The append body is `{ value, unit?, at? }`. History accepts `from`, `to`, `order`, and `limit` as
query parameters. Appending requires `can.append(Type)`; reading history requires `can.view(Type)`.
A device that only pushes readings needs the append grant alone — see
[Authorization](../auth/authorization.md). See the [HTTP reference](./http-reference.md) for the full object API.

## The telemetry.appended event

Every appended point emits a `telemetry.appended` domain event. Its payload is:

```ts
{
  objectTypeId: string
  objectId: string
  propertyId: string
  value: unknown
  unit?: string
  at: string // ISO 8601
}
```

Subscribe to it to react to new readings — drive [rules](../rules/overview.md), push live updates
to the UI, or fan out to a broker. See [events](../events/overview.md) for how to consume domain
events.

Point storage, the latest object value, the durable ontology commit, and stable event envelopes are
one atomic Materializer commit. Publication happens afterward with at-least-once delivery; a broker
outage delays the event but does not lose or roll back the telemetry point.

A point also refreshes the object's latest value for that property, so an append emits an
`object.updated` event alongside `telemetry.appended`.

## Related

- [Properties](../ontology/properties.md) — declaring `mode: "telemetry"` on a property.
- [Units and semantics](../ontology/units-and-semantics.md) — semantic types and valid units.
- [Projections](../data/projections.md) — appending telemetry from dataset rows.
- [Querying objects](./querying.md) — reading object records and their latest values.
