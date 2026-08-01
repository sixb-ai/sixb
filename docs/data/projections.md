# Projections

A projection turns dataset rows into ontology objects, links, and telemetry points. Reach for one
when you have clean tables — say invoices and customers pulled from your ERP — and want them to
become the `Invoice` and `Customer` objects your app reads through
[`sixb.objects(...)`](../objects/overview.md).

[Syncs](syncs.md) and [pipelines](pipelines.md) prepare the rows; projections create the objects and
links on top of them. `defineProjection` selects the right builder from its ontology target:

| Target | Produces | One row becomes |
| --- | --- | --- |
| `ObjectType` | Objects (and FK links) | One complete object root |
| `ObjectType.l.<linkId>` | Many-to-many links | One complete link root |
| `ObjectType.p.<telemetryId>` | Telemetry points | One reading on a series |

## Object projection

Each row becomes one object. Map object properties to dataset columns with `.properties(...)`. The
primary property (usually `id`) must be mapped.

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
    company: "company_name",
    industry: "industry_sector",
    tier: "service_tier",
  })
```

| Part | Meaning |
| --- | --- |
| `defineProjection(id, ObjectType)` | Names the projection and its target object type |
| `.fromDataset(dataset)` | Chooses the source dataset |
| `.properties({ prop: "column" })` | Maps object property ids to dataset column names |

The object property `id` reads from column `customer_id`, `name` from `contact_name`, and so on.

## Links from foreign keys

When a row carries a foreign key, turn it into an ontology link with `.withLinks(...)`. Each entry is
keyed by the link id and uses the inline `{ link, sourceField, target }` descriptor:

```ts
import { defineProjection } from "@sixb/core"
import { erpInvoicesDataset } from "../datasets/erp"
import { Customer } from "../ontology/customer"
import { Invoice } from "../ontology/invoice"
import { Project } from "../ontology/project"

export const invoiceProjection = defineProjection("invoice-proj", Invoice)
  .fromDataset(erpInvoicesDataset)
  .properties({
    id: "id",
    number: "number",
    amount: "amount",
    currency: "currency",
    status: "status",
    issuedAt: "issuedAt",
    dueDate: "dueDate",
  })
  .withLinks({
    customer: {
      link: Invoice.l.customer,
      sourceField: "customer_id",
      target: Customer,
    },
    project: {
      link: Invoice.l.project,
      sourceField: "project_id",
      target: Project,
    },
  })
```

The value in `customer_id` equals the primary id of a `Customer`, so the projection creates the
`Invoice -> Customer` link; `project_id` creates `Invoice -> Project`.

### Descriptor fields

| Field | Meaning |
| --- | --- |
| `link` | The link token from the source object type (`SourceType.l.<linkId>`) |
| `sourceField` | Dataset column holding the target's primary id |
| `sourceProperty` | Alternative to `sourceField`: a projected property token (`SourceType.p.<propId>`) holding the target id |
| `target` | The target object type (must be the link's declared target or a subtype via `extends`) |

`sourceField` and `sourceProperty` are mutually exclusive — provide exactly one. Use `sourceField`
when the foreign key lives only in the dataset; use `sourceProperty` when you also map that column to
an object property and want to reuse it.

The inline descriptor is sugar over the `fromForeignKey()` helper. The two are equivalent — prefer
the inline form; reach for `fromForeignKey()` only to build a descriptor separately.

## Many-to-many link projection

When a join dataset stores relationships, target its link token. Each row becomes one link from a
source object to a target object, identified by their primary ids.

```ts
import { defineProjection } from "@sixb/core"
import { erpProjectMembersDataset } from "../datasets/erp"
import { Project } from "../ontology/project"

export const projectMembersProjection = defineProjection("project-members", Project.l.members)
  .fromDataset(erpProjectMembersDataset)
  .sourceField("project_id")
  .targetField("employee_id")
```

| Part | Meaning |
| --- | --- |
| `defineProjection(id, SourceType.l.<linkId>)` | Names the projection and its target link |
| `.sourceField("column")` | Dataset column holding the source object's primary id |
| `.targetField("column")` | Dataset column holding the target object's primary id |

Source and target fields must be string columns.

## Telemetry projection

A telemetry projection records timestamped readings onto a telemetry-mode property. Use it when a
dataset has one row per measurement: a value, the object it belongs to, and when it was recorded.

First mark the property as telemetry in the ontology (see
[Properties](../ontology/properties.md)):

```ts
prop("progress", "integer", { mode: "telemetry" })
```

Then map a dataset of readings onto it with `.points(...)`:

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

| Mapping key | Meaning |
| --- | --- |
| `objectId` | Dataset column holding the target object's primary id |
| `at` | Timestamp column for the reading |
| `value` | Column holding the reading |
| `unit` | Optional column holding the reading's unit (required only for properties that carry a unit) |

Each row appends one point to the `progress` series of the `Project` named by `project_id`. The `at`
column must be a string, date, or timestamp; values without a time zone (no trailing `Z` or numeric
offset) are read as UTC.

How point identity works — and what re-projecting the same instant does — is covered in
[Telemetry](../objects/telemetry.md).

## Projection vs pipeline

[Pipelines](pipelines.md) and projections solve different problems: pipelines make better rows,
projections make objects.

| Need | Use |
| --- | --- |
| Clean, filter, join, or reshape rows | Pipeline |
| Create app objects from rows | Projection |
| Create object relationships from foreign keys | Projection |
| Record timestamped readings on a property | Projection |
| Keep data as tables | Dataset or pipeline |

## Registration

Put projection definitions in `projections/` and export them. `createSixb()` discovers them
automatically.

```txt
your-project/
  datasets/
    erp.ts
  ontology/
    customer.ts
    invoice.ts
  projections/
    customer-projection.ts
    invoice-projection.ts
  sixb.config.ts
```

You can also register them explicitly:

```ts
import { createSixb } from "@sixb/core"
import { erpInvoicesDataset } from "./datasets/erp"
import { Invoice } from "./ontology/invoice"
import { invoiceProjection } from "./projections/invoice-projection"

export const sixb = await createSixb({
  ontologies: [Invoice],
  datasets: [erpInvoicesDataset],
  projections: [invoiceProjection],
})
```

See the [Runtime](../runtime/overview.md) overview for how discovery works.

## Running projections

A committed dataset version triggers projection execution. In local development, `sixb dev` co-hosts
projection workers when projections are registered. For a separate worker process:

```bash
sixb worker projection
```

## Behavior and validation

- `.properties(...)` checks that mapped properties and columns exist and that their types are
  compatible. The primary property must be mapped.
- Object and link projections are authoritative replacements for their source. A later dataset
  version withdraws source-owned objects or links that are no longer present; managed edits remain
  separate overrides.
- Replacement snapshots are the only V0.1.0 source materialization protocol. Activation, the
  durable `ontology_commits` record, and stable outbox envelopes commit atomically. Dataset CDC or
  change-stream projection is deferred.
- An object projection requires one nonblank primary identity per dataset row and one row per object
  root. Repeated roots fail the run instead of merging partial object state.
- A nonblank FK contributes a link from that object row. Blank FKs contribute no link. Model
  cardinality-many relationships with a dedicated link projection, where each dataset row is one
  complete link root.
- Link projections require string source and target fields.
- For an FK descriptor, `target` must be the link's declared target type or a subtype (via
  `extends`).

## Related

- [Datasets](datasets.md) and [Pipelines](pipelines.md) — prepare the rows projections consume
- [Objects](../objects/overview.md) and [Telemetry](../objects/telemetry.md) — what projections produce
- [Links](../ontology/links.md) — the relationships FK and link projections build
