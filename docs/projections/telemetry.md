# Telemetry projections

A telemetry projection maps timestamped dataset readings to an object's property history.
It runs automatically when the source dataset updates.

## Define a telemetry projection

Mark the property as telemetry in your [ontology](../ontology/properties.md):

```ts
prop("progress", "integer", { mode: "telemetry" })
```

Export the projection from `projections/`. Target the property and map the columns holding the
object's ID, the reading's timestamp, and its value. The target object must exist to receive readings.

File: `projections/project-progress.ts`

```ts
import { defineProjection } from "@sixb/core"
import { projectReadings } from "../datasets/project-readings"
import { Project } from "../ontology/project"

export const projectProgressProjection = defineProjection(
  "project-progress",
  Project.p.progress
)
  .fromDataset(projectReadings)
  .points({
    objectId: "project_id",
    at: "recorded_at",
    value: "progress_pct",
  })
```

Use a string, date, or timestamp column for `at`. Timestamps without a time zone are read as UTC.
Blank values are skipped; invalid readings fail the run.

## Map multiple readings

When a row contains several readings for the same object and timestamp, target the object type
and map them together with `properties`. Use this in place of the single-property projection above.
Each mapped property must be declared with `mode: "telemetry"`, including `completedTasks` here.

```ts
export const projectProgressProjection = defineProjection(
  "project-progress",
  Project
)
  .fromDataset(projectReadings)
  .points({
    objectId: "project_id",
    at: "recorded_at",
    properties: {
      progress: "progress_pct",
      completedTasks: "completed_tasks",
    },
  })
```

## Readings with units

For a property with a [semantic type](../ontology/units-and-semantics.md), also map a unit column.
This example assumes `timeSpent` is a telemetry property with `semanticType: "TimeSpan"` and
`time_unit` contains a valid unit such as `hour`.

```ts
export const projectTimeProjection = defineProjection(
  "project-time",
  Project.p.timeSpent
)
  .fromDataset(projectReadings)
  .points({
    objectId: "project_id",
    at: "recorded_at",
    value: "time_spent",
    unit: "time_unit",
  })
```

Omit `unit` for properties without a semantic type.

See [Telemetry](../objects/telemetry.md) to read the history and latest values.
