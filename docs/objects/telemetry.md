# Telemetry

Telemetry stores a property's value over time.

Use it for measurements, readings, and counters where history matters: a thermostat's
temperature, a device's signal strength, a meter's running total. A telemetry property keeps the
full series of readings, and the object record always reflects the latest one.

## Telemetry property mode

A property becomes telemetry by setting `mode: "telemetry"` in the
[ontology](../ontology/properties.md). Without it, a property is `"static"`: a single fact on the
object record.

```ts
import { defineObjectType, prop } from "@sixb/core"

export const Thermostat = defineObjectType({
  id: "Thermostat",
  name: "Thermostat",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
    prop("temperature", "double", {
      mode: "telemetry",
      semanticType: "Temperature",
    }),
  ],
})
```

`semanticType` declares the unit family for numeric readings. It is optional, but when present
every appended point must carry a unit from that family. See
[units and semantics](../ontology/units-and-semantics.md) for the registry of quantitative types
and their unit ids.

Telemetry properties cannot use the `"fileRef"` schema.

## Append a point

Reach a single object with `.byId(id)`, select the telemetry property with the typed token
`Type.p.<name>`, and call `.append(...)`.

```ts
import { Thermostat } from "./ontology/thermostat"

await sixb.objects(Thermostat).byId("therm-001").telemetry(Thermostat.p.temperature).append({
  value: 21.5,
  unit: "degreeCelsius",
  at: new Date(),
})
```

`append(...)` takes:

| Field | Required | Meaning |
| --- | --- | --- |
| `value` | Yes | The reading. Validated against the property schema. |
| `unit` | When the property has a `semanticType` | A valid unit id for the property's quantitative type. |
| `at` | Yes | The instant of the reading, as a `Date`. |

The object must already exist. Appending to a missing object throws. The property must be
telemetry mode and the token must belong to the object type — both are checked before the write.

### Units

If a property declares a `semanticType`, a unit is required and must belong to that family.
A `Temperature` property accepts `degreeCelsius`, `degreeFahrenheit`, or `kelvin`; an
unrecognized unit is rejected:

```ts
// throws: [Sixb] Invalid unit 'millibar' for Thermostat.temperature (Temperature)
.append({ value: 21.5, unit: "millibar", at: new Date() })
```

If a property has no `semanticType`, passing a unit is an error. If it has one, omitting the unit
is an error. Unit ids and their families come from the
[quantitative types registry](../ontology/units-and-semantics.md).

## Append in batch

`appendTelemetryBatch` writes many points across many objects of one type in a single call. Wrap
a value as `{ value, unit }` when it carries a unit; otherwise pass the bare value.

```ts
await sixb.objects(Thermostat).appendTelemetryBatch([
  {
    id: "therm-001",
    properties: { temperature: { value: 21.5, unit: "degreeCelsius" } },
  },
  {
    id: "therm-002",
    properties: { temperature: { value: 19.0, unit: "degreeCelsius" } },
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

Every value is validated and every required unit is checked before any point is written. To
record readings from table data instead of code, use a
[telemetry projection](../data/projections.md).

## Identity: (series, at)

A telemetry point is uniquely identified by its series and its instant. The series is the tuple
`(objectType, object, property)`; the instant is `at`. Writing the same instant on the same
series again is a last-write-wins upsert — it updates the value rather than adding a duplicate.

This makes telemetry writes idempotent under replay: re-appending or re-projecting the same
`(series, at)` never produces a second point. The same rule governs
[telemetry projections](../data/projections.md).

## Read history and latest

Reads go through the time-series store at `sixb.storage.timeseries`.

```ts
const history = await sixb.storage.timeseries.getHistory({
  projectId: sixb.id,
  objectTypeId: "Thermostat",
  objectId: "therm-001",
  propertyId: "temperature",
  from: new Date("2026-06-01T00:00:00Z"),
  to: new Date("2026-06-23T00:00:00Z"),
  order: "desc",
  limit: 100,
})

const latest = await sixb.storage.timeseries.getLatest({
  projectId: sixb.id,
  objectTypeId: "Thermostat",
  objectId: "therm-001",
  propertyId: "temperature",
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

The append body is `{ value, unit?, at? }`. History accepts `from`, `to`, `order`, and `limit`
as query parameters. See the [HTTP reference](./http-reference.md) for the full object API.

## The telemetry.appended event

Every appended point emits a `telemetry.appended` domain event before it lands in storage. Its
payload is:

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

Subscribe to it to react to new readings — drive rules, push live updates to the UI, or fan out
to a broker. See [events](../events/overview.md) for how to consume domain events.

## Related

- [Properties](../ontology/properties.md) — declaring `mode: "telemetry"` on a property.
- [Units and semantics](../ontology/units-and-semantics.md) — semantic types and valid units.
- [Projections](../data/projections.md) — appending telemetry from dataset rows.
- [Querying objects](./querying.md) — reading object records and their latest values.
