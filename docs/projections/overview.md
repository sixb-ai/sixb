# Projections

A projection maps dataset rows to objects, relationships, or time-series readings in your domain
model. It runs automatically when the source dataset updates.

## Define a projection

Export a projection from your project's `projections/` folder. Choose its dataset and object type,
then map object properties to dataset columns with `.properties(...)`.

Each row represents one object. Map its primary property to a column with a unique, nonblank ID.

File: `projections/customers.ts`

```ts
import { defineProjection } from "@sixb/core"
import { customers } from "../datasets/customers"
import { Customer } from "../ontology/customer"

export const customerProjection = defineProjection("customers", Customer)
  .fromDataset(customers)
  .properties({
    id: "customer_id",
    name: "contact_name",
    email: "contact_email",
  })
```

Use a [pipeline](../pipelines/overview.md) first if the rows need cleaning or reshaping.
Removing a dataset row withdraws its projected values and links, but does not delete the object.

If the object type defines [vector search profiles](../ontology/properties.md#configure-vector-search),
projections also refresh their embeddings in the background. Objects become searchable once the
embeddings are ready; generation counts toward the [project's AI limits](../models/usage-and-limits.md#embeddings).

## Add relationships

Use `.withLinks(...)` when a row contains another object's ID. Here, `customer_id` identifies the
customer linked to each invoice through the `customer` link defined on `Invoice`.
A blank foreign key creates no link.

File: `projections/invoices.ts`

```ts
import { defineProjection } from "@sixb/core"
import { invoices } from "../datasets/invoices"
import { Customer } from "../ontology/customer"
import { Invoice } from "../ontology/invoice"

export const invoiceProjection = defineProjection("invoices", Invoice)
  .fromDataset(invoices)
  .properties({
    id: "invoice_id",
    number: "invoice_number",
  })
  .withLinks({
    customer: {
      link: Invoice.l.customer,
      sourceField: "customer_id",
      target: Customer,
    },
  })
```

## Project relationships from a separate dataset

For many-to-many relationships, target a link instead of an object type. Each row identifies the
two objects to connect. The source and target columns must contain their primary IDs as strings.

File: `projections/project-members.ts`

```ts
import { defineProjection } from "@sixb/core"
import { projectMembers } from "../datasets/project-members"
import { Project } from "../ontology/project"

export const projectMembersProjection = defineProjection(
  "project-members",
  Project.l.members
)
  .fromDataset(projectMembers)
  .sourceField("project_id")
  .targetField("employee_id")
```

## Source updates and app edits

By default, an app edit to a projected property takes precedence over later source updates until
the app resets that edit.

To use the most recent value instead, append `.resolveConflicts(...)` to the object projection:

```ts
.resolveConflicts({
  strategy: "mostRecent",
  sourceTimestamp: "updated_at",
})
```

`updated_at` must be a non-null `timestamp` column containing the source record's update time,
not its ingestion time. For each property, a source value replaces an app edit when its timestamp
is equal to or newer than the edit's timestamp.

For timestamped readings, see [Telemetry projections](telemetry.md).
