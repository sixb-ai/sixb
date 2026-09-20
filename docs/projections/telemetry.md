# Telemetry projections

A telemetry projection records timestamped readings onto telemetry-mode properties. When one row
contains several readings for the same object and instant, map them together from the object type:

First mark the property as telemetry in the ontology (see
[Properties](../ontology/properties.md)):

```ts
prop("progress", "integer", { mode: "telemetry" })
```

Then map the dataset with `.points(...)`:

```ts
import { defineProjection } from "@sixb/core"
import { googleAnalyticsActivity } from "../datasets/google-analytics"
import { GoogleAnalyticsProperty } from "../ontology/google-analytics-property"

export const activityProjection = defineProjection("ga-activity", GoogleAnalyticsProperty)
  .fromDataset(googleAnalyticsActivity)
  .points({
    objectId: "account_id",
    at: "day",
    properties: {
      activeUsers: "active_users",
      newUsers: "new_users",
      engagementDuration: "engagement_duration",
    },
  })
```

| Mapping key | Meaning |
| --- | --- |
| `objectId` | Dataset column holding the target object's primary id |
| `at` | Timestamp column for the reading |
| `properties.<id>` | Shorthand value column for a unitless telemetry property |
| `properties.<id>.value` | Value column when the property also needs a unit |
| `properties.<id>.unit` | Unit column; required for semantic types with units and forbidden otherwise |

A blank value skips that property's point. A row is skipped when it emits no points. A nonblank invalid value or unit rejects the
whole batch, so a row cannot be partially committed. The `at` column must be a
string, date, or timestamp; values without a time zone (no trailing `Z` or numeric offset) are read
as UTC.

Group properties only when they share the same dataset, object id, timestamp, and projection
lifecycle. Each mapped telemetry property has its own series and belongs to this projection.

For a dataset with one telemetry value per row, the property-token form remains concise sugar for a
one-property `properties` mapping:

```ts
import { defineProjection } from "@sixb/core"
import { erpProjectProgressDataset } from "../datasets/erp"
import { Project } from "../ontology/project"

export const projectProgressProjection = defineProjection(
  "project-progress",
  Project.p.progress
)
  .fromDataset(erpProjectProgressDataset)
  .points({
    objectId: "project_id",
    at: "recorded_at",
    value: "progress_pct",
  })
```

How point identity works — and what re-projecting the same instant does — is covered in
[Telemetry](../objects/telemetry.md).
