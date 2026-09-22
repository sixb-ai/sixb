# Telemetry

Telemetry records a property's value over time, such as a project's progress or a sensor's
readings. The object exposes the latest value while the full history remains available to query.

## Define a telemetry property

Add `mode: "telemetry"` to a [property](../ontology/properties.md):

```ts
import { prop } from "@sixb/core/ontology"

prop("progress", "integer", { mode: "telemetry" })
```

Include this property in your object type's `properties` array.

## Append a point

Select an existing object and its telemetry property, then provide the value and the time of the
reading as a `Date`:

```ts
import { Project } from "./ontology/project"

const progress = sixb.objects(Project).byId("proj-001").telemetry(Project.p.progress)

await progress.append({
  value: 45,
  at: new Date("2026-09-01T12:00:00Z"),
})
```

The object must exist before you append. Writing to the same object, property, and timestamp
replaces that point. An older reading adds to the history without replacing a newer reading
as the object's latest value.

## Read history

Use `history()` to read points within a time range. Results contain `{ value, at, unit? }` and
arrive oldest first unless you pass `order: "desc"`. Both time bounds are inclusive:

```ts
const points = await progress.history({
  from: new Date("2026-09-01T00:00:00Z"),
  to: new Date("2026-09-07T23:59:59Z"),
  limit: 100,
})
```

To read the latest point with its timestamp, request one point in descending order.
An empty series returns an empty array:

```ts
const [latest] = await progress.history({ order: "desc", limit: 1 })
```

## Append in batch

Use `appendTelemetryBatch()` to record values for several objects of the same type. Each item
can contain multiple telemetry properties. Its optional `at` applies to every property in that
item and defaults to the current time:

```ts
await sixb.objects(Project).appendTelemetryBatch([
  { id: "proj-001", properties: { progress: 45 } },
  { id: "proj-002", properties: { progress: 70 } },
])
```

To import readings from a dataset, use a [telemetry projection](../projections/telemetry.md).

## Values with units

For a property with a quantitative `semanticType`, include a valid `unit` with each point.
Properties without a semantic type do not accept units. See
[Units](../ontology/units-and-semantics.md).

```ts
await sixb.objects(Project).byId("proj-001").telemetry(Project.p.timeSpent).append({
  value: 2,
  unit: "hour",
  at: new Date("2026-09-01T12:00:00Z"),
})
```

In a batch, supply the property as `{ value: 2, unit: "hour" }`.
