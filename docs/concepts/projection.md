# Projection

A projection turns dataset rows into ontology objects and links.

Use projections after syncs and pipelines have produced clean table data. Projections are the
step that makes that data show up as typed app objects.

## Why it is useful

Datasets are tables. Ontology types are app objects.

A projection connects those two worlds:

- map dataset columns to object properties
- create or update objects from rows
- create links from foreign key columns
- keep app state in sync with committed dataset versions

In a typical app, syncs and pipelines prepare clean datasets before projections create objects and
links.

## Define an object projection

File: `projections/customer.ts`

```ts
import { defineProjection } from "@sixb/core"
import { customersDataset } from "../datasets/customers"
import { Customer } from "../ontology/customer"

export const customerProjection = defineProjection("customers", Customer)
  .fromDataset(customersDataset)
  .properties({
    id: "customer_id",
    name: "contact_name",
    email: "contact_email",
    tier: "service_tier",
  })
```

Each row in `customersDataset` becomes a `Customer` object.

The object property `id` is read from the dataset column `customer_id`. The object property
`name` is read from `contact_name`, and so on.

## What each part does

| Part | Meaning |
| --- | --- |
| `defineProjection("customers", Customer)` | Names the projection and target object type |
| `.fromDataset(customersDataset)` | Chooses the source dataset |
| `.properties({ ... })` | Maps object properties to dataset columns |

The primary property must be mapped. For `Customer`, that is usually `id`.

## Project links from foreign keys

If a dataset row contains a foreign key, a projection can turn it into an ontology link.

```ts
import { defineProjection, fromForeignKey } from "@sixb/core"
import { customersDataset } from "../datasets/customers"
import { Customer } from "../ontology/customer"
import { Employee } from "../ontology/employee"

export const customerProjection = defineProjection("customers", Customer)
  .fromDataset(customersDataset)
  .properties({
    id: "customer_id",
    name: "contact_name",
    accountManagerRef: "account_manager_id",
  })
  .withLinks({
    accountManager: fromForeignKey({
      link: Customer.l.accountManager,
      sourceProperty: Customer.p.accountManagerRef,
      target: Employee,
    }),
  })
```

Here, `account_manager_id` stores the primary id of an `Employee`. The projection uses that
value to create the `Customer -> Employee` link.

## Project many-to-many links

Use a link projection when a join dataset stores relationships.

```ts
import { defineLinkProjection } from "@sixb/core"
import { projectMembersDataset } from "../datasets/projects"
import { Project } from "../ontology/project"

export const projectMembersProjection = defineLinkProjection("project-members", Project.l.members)
  .fromDataset(projectMembersDataset)
  .sourceField("project_id")
  .targetField("employee_id")
```

Each row creates one link from a `Project` to an `Employee`.

## Projection vs pipeline

Pipelines and projections solve different problems.

| Need | Use |
| --- | --- |
| Clean, filter, join, or reshape rows | Pipeline |
| Create app objects from rows | Projection |
| Create object relationships from foreign keys | Projection |
| Keep data as tables | Dataset or pipeline |

A good rule: pipelines make better rows; projections make objects.

## Convention

Put projection definitions in `projections/` and export them.

```txt
your-project/
  datasets/
    customers.ts
    projects.ts
  ontology/
    customer.ts
    employee.ts
    project.ts
  projections/
    customers.ts
    project-members.ts
  sixb.config.ts
```

`createSixb()` discovers exported projection definitions from `projections/` automatically.

You can also register projections explicitly:

```ts
import { createSixb } from "@sixb/core"
import { customersDataset } from "./datasets/customers"
import { Customer } from "./ontology/customer"
import { customerProjection } from "./projections/customers"

export const sixb = createSixb({
  datasets: [customersDataset],
  ontology: [Customer],
  projections: [customerProjection],
})
```

## How to model projections

Start with one object type.

1. Choose the clean dataset you want to project.
2. Choose the ontology object type the rows should become.
3. Map the primary property first.
4. Map the simple properties next.
5. Add links only when the dataset has reliable foreign keys.

Good projection names usually describe the object or relationship they materialize:

- `customers`
- `invoices`
- `projects`
- `project-members`

## Running projections

In local development, `sixb dev` can co-host projection workers when projections are
registered.

For a separate worker process:

```bash
sixb worker --worker projection
```

## Extra details

- `.properties(...)` checks that mapped object properties and dataset columns exist.
- mapped dataset column types must be compatible with object property schemas.
- the primary property must be mapped.
- projection execution is triggered by committed dataset versions.
- projections are set-only in V1: missing rows do not delete existing objects or links.
- link projections require string source and target fields.

The important first step is to decide which clean table should become which object type.
