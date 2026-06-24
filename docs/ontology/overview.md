# Ontology

An ontology is your app's object model — the real things your business runs on, defined once
and used everywhere. Reach for it whenever you have nouns that people interact with: customers,
projects, employees, invoices, tasks.

Each object type declares the properties it holds and the links it can make to other types.
This section covers how to model those types and the values they carry.

## Why model an ontology

An ontology gives your project a shared language. Instead of passing loose JSON around, you
define the important objects once, and that definition does work everywhere:

- App screens know exactly which properties exist
- Workflows request actions against real objects
- Projections turn external rows into typed objects
- TypeScript catches property and link mistakes at compile time
- Sixb validates every write before it becomes app state

Use an ontology for the objects people interact with. Use [datasets](../data/datasets.md) for
raw rows and table-shaped data.

## Core terms

| Term | Meaning | Example |
| --- | --- | --- |
| Object type | A kind of thing | `Customer`, `Invoice` |
| Object | One instance of a type | customer `cust-001` |
| Property | A value on the object | `name`, `email`, `tier` |
| Link | A relationship to another object | a project's `customer` |
| Telemetry | A property whose value changes over time | `Project.progress` |

## Defining a type

Define object types declaratively with `defineObjectType`, composing properties with `prop`
and relationships with `link`:

```ts
import { defineObjectType, link, prop, stringEnum } from "@sixb/core/ontology"
import { Employee } from "./employee"

export const Customer = defineObjectType({
  id: "Customer",
  name: "Customer",
  description: "A company customer.",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", {
      required: true,
      query: { searchable: true, text: true, exact: true, sortable: true, weight: 5 },
    }),
    prop("email", "string", {
      required: true,
      query: { searchable: true, filterable: true, exact: true },
    }),
    prop("company", "string", { required: true }),
    prop("industry", "string"),
    prop("tier", stringEnum(["bronze", "silver", "gold", "platinum"]), {
      query: { searchable: true, filterable: true, exact: true, facet: true },
    }),
  ],
  links: [link("accountManager", Employee, { cardinality: "one" })],
})
```

Every object type needs exactly one primary property — a `"string"` schema marked
`{ required: true, primary: true }`. It uniquely identifies each object of that type.

Import ontology builders from `@sixb/core/ontology` so they stay safe to use in browser and app
code. The runtime (`createSixb`) is imported from `@sixb/core`.

> A property is only queryable if it declares `query` metadata. Filter, sort, or facet only on
> properties that opt in. See [search metadata](./search-metadata.md).

## The `.p` and `.l` token model

Every registered object type carries two typed token maps so runtime and client APIs can target
properties and links without raw string ids:

| Token | Access | Use it for |
| --- | --- | --- |
| Property token | `Type.p.<propertyId>` | Telemetry, queries, any API that targets a property |
| Link token | `Type.l.<linkId>` | Creating and navigating relationships |

```ts
Customer.p.tier          // PropertyToken for the tier property
Customer.l.accountManager // LinkToken for the accountManager relationship
```

Tokens are strongly typed against the type's properties and links, so a typo or a missing
property is a compile error rather than a runtime surprise. See
[querying](../objects/querying.md) and [telemetry](../objects/telemetry.md) for how tokens flow
through runtime APIs.

## Modeling money and telemetry

Two conventions keep numeric values correct:

- **Money** is an `amount` (`"double"`) plus a `currency` (`stringEnum`). There is no currency
  quantitative type — never model money with units.
- **Telemetry** is a numeric property with `mode: "telemetry"` and no `semanticType`, so it
  records a history instead of a single current value.

```ts
import { defineObjectType, link, prop, stringEnum } from "@sixb/core/ontology"
import { Customer } from "./customer"
import { Project } from "./project"

export const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  description: "A billing invoice for a customer.",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("number", "string", {
      required: true,
      query: { searchable: true, filterable: true, exact: true, sortable: true },
    }),
    prop("amount", "double", {
      required: true,
      query: { searchable: true, filterable: true, sortable: true },
    }),
    prop("currency", stringEnum(["EUR", "USD", "GBP"]), {
      query: { searchable: true, filterable: true, exact: true, facet: true },
    }),
    prop("status", stringEnum(["draft", "sent", "paid", "overdue", "cancelled"]), {
      query: { searchable: true, filterable: true, exact: true, facet: true },
    }),
    prop("issuedAt", "timestamp"),
    prop("dueDate", "date"),
  ],
  links: [
    link("customer", Customer, { cardinality: "one" }),
    link("project", Project, { cardinality: "one" }),
  ],
})
```

Physical readings (temperature, pressure) are the one case for unit-aware numbers — see
[units and semantics](./units-and-semantics.md).

## Discovery and registration

Put object types in `ontology/` and export them:

```txt
your-project/
  ontology/
    customer.ts
    employee.ts
    invoice.ts
    project.ts
  sixb.config.ts
```

`createSixb()` discovers exported object types from `ontology/` automatically. You can also
register them explicitly with the `ontologies` option:

```ts
import { createSixb } from "@sixb/core"
import { Customer } from "./ontology/customer"
import { Invoice } from "./ontology/invoice"

export const sixb = await createSixb({
  ontologies: [Customer, Invoice],
})
```

`createSixb()` is async — always `await` it. See the [runtime overview](../runtime/overview.md)
for the full discovery model.

## How to model your domain

Start small and grow only where the app needs it.

1. Pick one object your app cares about, like `Customer`.
2. Give it an `id` primary property.
3. Add the properties users see or workflows act on.
4. Add `query` metadata to the properties you filter, sort, or search.
5. Add links only for relationships that matter in the app.
6. Add telemetry only where history matters, like `Project.progress`.

Good object types are business-readable. `Customer`, `Invoice`, `Project`, and `Task` make
better names than implementation details.

## In this section

| Page | What it covers |
| --- | --- |
| [Object types](./object-types.md) | Defining types, the primary property, inheritance with `extends` |
| [Properties](./properties.md) | Static and telemetry properties, schemas, options |
| [Links](./links.md) | Relationships, cardinality, link properties |
| [Value types](./value-types.md) | Reusable named value shapes with `defineValueType` |
| [Units and semantics](./units-and-semantics.md) | Quantitative types and unit-aware numbers |
| [Search metadata](./search-metadata.md) | Making types and properties queryable |
