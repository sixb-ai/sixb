# Projections

A projection turns dataset rows into ontology objects, links, and telemetry points.

Datasets are tables; ontology types are app objects. A projection connects the two worlds: it maps
dataset columns to object properties, creates or updates objects from rows, builds links from
foreign-key columns, and appends timestamped readings to telemetry properties. In a typical app,
[syncs](syncs.md) and [pipelines](pipelines.md) prepare clean datasets before projections create
the objects and links your app reads through [`sixb.objects(...)`](../objects/overview.md).

There are three kinds of projection:

| Builder | Produces | One row becomes |
| --- | --- | --- |
| `defineProjection` | Objects (and FK links) | One object upsert |
| `defineLinkProjection` | Many-to-many links | One link |
| `defineTelemetryProjection` | Telemetry points | One reading on a series |

## Object projection

Each row in the dataset becomes one object. Map object properties to dataset columns with
`.properties(...)`. The primary property (usually `id`) must be mapped.

```ts
import { defineProjection } from "@sixb/core"
import { erpCustomersDataset } from "../datasets/erp"
import { Customer } from "../ontology/customer"

export const customerProjection = defineProjection("customer-proj", Customer)
  .fromDataset(erpCustomersDataset)
  .properties({
    id: "customer_id",
    name: "contact_name",
    email: "contact_email",
    tier: "service_tier",
  })
```

| Part | Meaning |
| --- | --- |
| `defineProjection(id, ObjectType)` | Names the projection and its target object type |
| `.fromDataset(dataset)` | Chooses the source dataset |
| `.properties({ prop: "column" })` | Maps object property ids to dataset column names |

The object property `id` is read from column `customer_id`, `name` from `contact_name`, and so on.

## Project links from foreign keys

When a dataset row carries a foreign key, a projection can turn it into an ontology link with
`.withLinks(...)`. Each entry is keyed by the link id and describes where the target id comes from.

The simplest form reads the foreign key straight from a dataset column. This is the inline
`{ link, sourceField, target }` descriptor:

```ts
import { defineProjection } from "@sixb/core"
import { erpCustomersDataset } from "../datasets/erp"
import { Customer } from "../ontology/customer"
import { Employee } from "../ontology/employee"

export const customerProjection = defineProjection("customer-proj", Customer)
  .fromDataset(erpCustomersDataset)
  .properties({
    id: "customer_id",
    name: "contact_name",
    email: "contact_email",
  })
  .withLinks({
    accountManager: {
      link: Customer.l.accountManager,
      sourceField: "account_mgr_id",
      target: Employee,
    },
  })
```

The value in `account_mgr_id` equals the primary id of an `Employee`, so the projection creates the
`Customer -> Employee` link. A single object projection can declare several links at once:

```ts
  .withLinks({
    project: { link: Task.l.project, sourceField: "project_id", target: Project },
    assignee: { link: Task.l.assignee, sourceField: "assignee_id", target: Employee },
  })
```

### Descriptor fields

| Field | Meaning |
| --- | --- |
| `link` | The link token from the source object type (`SourceType.l.<linkId>`) |
| `sourceField` | Dataset column holding the target's primary id |
| `sourceProperty` | Alternative to `sourceField`: a projected object property token (`SourceType.p.<propId>`) holding the target id |
| `target` | The target object type (must be the link's declared target or a subtype) |

`sourceField` and `sourceProperty` are mutually exclusive — provide exactly one. Use `sourceField`
when the foreign key lives only in the dataset; use `sourceProperty` when you also map that column
to an object property and want to reuse it.

### `fromForeignKey()` helper

The inline descriptor is sugar over `fromForeignKey()`. The two forms are equivalent — prefer the
inline object form used above; reach for `fromForeignKey()` only when you want to build a descriptor
separately:

```ts
import { defineProjection, fromForeignKey } from "@sixb/core"

  .withLinks({
    accountManager: fromForeignKey({
      link: Customer.l.accountManager,
      sourceField: "account_mgr_id",
      target: Employee,
    }),
  })
```

## Many-to-many link projection

When a join dataset stores relationships, use `defineLinkProjection`. Each row becomes one link from
a source object to a target object, identified by their primary ids.

```ts
import { defineLinkProjection } from "@sixb/core"
import { erpProjectMembersDataset } from "../datasets/erp"
import { Project } from "../ontology/project"

export const projectMembersProjection = defineLinkProjection("project-members", Project.l.members)
  .fromDataset(erpProjectMembersDataset)
  .sourceField("project_id")
  .targetField("employee_id")
```

| Part | Meaning |
| --- | --- |
| `defineLinkProjection(id, SourceType.l.<linkId>)` | Names the projection and its target link |
| `.sourceField("column")` | Dataset column holding the source object's primary id |
| `.targetField("column")` | Dataset column holding the target object's primary id |

Source and target fields must be string columns.

## Telemetry projection

A telemetry projection records timestamped readings onto a telemetry-mode property. Use it when a
dataset has one row per measurement: a value, the object it belongs to, and when it was recorded.

First mark the property as telemetry in the ontology (see [Properties](../ontology/properties.md)):

```ts
prop("progress", "integer", { mode: "telemetry" })
```

Then map a dataset of readings onto it with `.points(...)`:

```ts
import { defineTelemetryProjection } from "@sixb/core"
import { erpProjectProgressDataset } from "../datasets/erp"
import { Project } from "../ontology/project"

export const projectProgressProjection = defineTelemetryProjection(
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

| Mapping key | Meaning |
| --- | --- |
| `objectId` | Dataset column holding the target object's primary id |
| `at` | Timestamp column for the reading |
| `value` | Column holding the reading |
| `unit` | Optional column holding the reading's unit (required for properties that carry a unit) |

Each row appends one point to the `progress` series of the `Project` named by `project_id`. The most
recent reading also materializes onto the object, so the property reflects the latest value while the
full history stays queryable. Telemetry point identity (and how re-projecting the same instant
behaves) is covered in [Telemetry](../objects/telemetry.md).

The `at` column must be a string, date, or timestamp. Values without a time zone (no trailing `Z` or
numeric offset) are read as UTC.

## Projection vs pipeline

[Pipelines](pipelines.md) and projections solve different problems.

| Need | Use |
| --- | --- |
| Clean, filter, join, or reshape rows | Pipeline |
| Create app objects from rows | Projection |
| Create object relationships from foreign keys | Projection |
| Record timestamped readings on a property | Projection |
| Keep data as tables | Dataset or pipeline |

A good rule: pipelines make better rows; projections make objects.

## Registration

Put projection definitions in `projections/` and export them. `createSixb()` discovers them
automatically.

```txt
your-project/
  datasets/
    erp.ts
  ontology/
    customer.ts
    employee.ts
    project.ts
  projections/
    customer-projection.ts
    project-members-projection.ts
  sixb.config.ts
```

You can also register projections explicitly:

```ts
import { createSixb } from "@sixb/core"
import { erpCustomersDataset } from "./datasets/erp"
import { Customer } from "./ontology/customer"
import { customerProjection } from "./projections/customer-projection"

export const sixb = createSixb({
  datasets: [erpCustomersDataset],
  ontology: [Customer],
  projections: [customerProjection],
})
```

See the [Runtime](../runtime/overview.md) overview for how discovery works.

## Running projections

Projection execution is triggered by committed dataset versions. In local development, `sixb dev`
co-hosts projection workers when projections are registered. For a separate worker process:

```bash
sixb worker projection
```

## Behavior and validation

- `.properties(...)` checks that mapped object properties and dataset columns exist, and that their
  types are compatible.
- The primary property must be mapped.
- Projections are set-only in V1: missing rows do not delete existing objects or links.
- Link projections require string source and target fields.
- For the inline FK descriptor, `target` must be the link's declared target type or a subtype (via
  `extends`).
