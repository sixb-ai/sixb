# Projections

A projection maps dataset rows to ontology objects, links, or time-series readings.
It runs when the source dataset commits a version. Clean or reshape rows first with a [pipeline](../pipelines/overview.md).

| Target | Produces | One row becomes |
| --- | --- | --- |
| `ObjectType` + `.properties(...)` | Objects (and FK links) | One object |
| `ObjectType` + `.points(...)` | [Grouped telemetry points](telemetry.md) | Zero to N readings sharing one object and instant |
| `ObjectType.l.<linkId>` | Many-to-many links | One link |
| `ObjectType.p.<telemetryId>` | [Telemetry points](telemetry.md) | One reading on a series |

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

### Source and managed-edit conflict resolution

By default, an Action or runtime edit to a projected property remains authoritative until
application code resets that property. This `editsWin` policy is useful when Sixb owns the decision.

When the source system remains authoritative, use `mostRecent` with a non-null timestamp column
that contains the source system's own update time:

```ts
export const githubIssueProjection = defineProjection("github-issues", GitHubIssue)
  .fromDataset(githubIssues)
  .properties({
    id: "id",
    title: "title",
    body: "body",
    state: "state",
  })
  .resolveConflicts({
    strategy: "mostRecent",
    sourceTimestamp: "updated_at",
  })
```

A source value wins when its timestamp is equal to or newer than that property's last app edit.
Each property is compared independently; unmapped properties remain editable only by the app.

Use the source record's update time, with a timezone and sufficient precision. It must increase
for each record, and the source clock must be reasonably synchronized with Sixb's clock.
Do not use ingestion time.

## Links from foreign keys

When a row carries a foreign key, turn it into an ontology link with `.withLinks(...)`. Each entry is
keyed by the link id and uses the inline `{ link, sourceField, target }` descriptor:

```ts
import { defineProjection } from "@sixb/core"
import { erpInvoicesDataset } from "../datasets/erp"
import { Customer } from "../ontology/customer"
import { Invoice } from "../ontology/invoice"

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
  })
```

The value in `customer_id` equals the primary id of a `Customer`, so the projection creates the
`Invoice → Customer` link.

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

Map timestamped values with `.points(...)`. See [Telemetry projections](telemetry.md) for single-series and grouped readings.

## File location

Export definitions from `projections/`. See [Project structure](../fundamentals/project-structure.md) for discovery rules.

## Behavior and validation

- `.properties(...)` checks that mapped properties and columns exist and that their types are
  compatible. The primary property must be mapped.
- Each new dataset version replaces the projection's contributions. Removed rows withdraw their
  projected values and links; they do not automatically delete ontology objects. App edits remain
  separate overrides.
- Link overrides follow ontology cardinality: a `many` override owns one exact edge, while a `one`
  override owns the `(source, linkId)` slot. A projected target change therefore stays hidden until
  that slot is reset; it cannot create a second effective target beside the managed one.
- With DuckLake or InMemoryLakeStorage, object and link projections update changed source records when possible, with a full refresh when needed. No extra configuration is required.
- An object projection requires one nonblank primary identity per dataset row and one row per object. Repeated roots fail the run instead of merging partial object state.
- A nonblank FK contributes a link from that object row. Blank FKs contribute no link. Model
  cardinality-many relationships with a dedicated link projection, where each dataset row is one
  link.
- Link projections require string source and target fields.
- For an FK descriptor, `target` must be the link's declared target type or a subtype (via
  `extends`).

## Run statistics

Atlas shows **Changes read** for incremental runs and **Rows read** for complete reads.
These count input work, not the number of objects changed. Incremental projection does not
mean the upstream sync reads less data.

## Related

- [Datasets](../datasets/overview.md) and [Pipelines](../pipelines/overview.md) — prepare the rows projections consume
- [Objects](../objects/overview.md) and [Telemetry](../objects/telemetry.md) — what projections produce
- [Links](../ontology/links.md) — the relationships FK and link projections build
