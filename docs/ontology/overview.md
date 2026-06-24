# Ontology

An ontology is your app's object model.

It defines the real things your software cares about — customers, orders, invoices, devices,
buildings, rooms, projects, tasks. Each object type declares the properties it has and the
relationships it can make to other object types. This section covers how to model those types
and the values they hold.

## Why it is useful

An ontology gives your project a shared language. Instead of passing around loose JSON, you
define the important objects once and use those definitions everywhere:

- app screens know what properties exist
- workflows can request actions against real objects
- projections can turn rows into objects
- TypeScript can catch property and relationship mistakes
- Sixb can validate writes before they become app state

Use an ontology for the objects people interact with. Use [datasets](../data/datasets.md) for
raw rows and table-shaped data.

## Core terms

| Concept | Meaning |
| --- | --- |
| Object type | A kind of thing, like `Customer` or `Order` |
| Object | One instance of that type, like customer `cust-001` |
| Property | A value on the object, like `name`, `email`, or `status` |
| Link | A relationship to another object, like a customer belonging to an organization |
| Telemetry | A property value that changes over time, like temperature or monthly spend |

Most ontologies start as nouns and relationships from your domain.

## Mental model

You define object types declaratively with `defineObjectType`, composing properties with `prop`
and relationships with `link`:

```ts
import { defineObjectType, link, prop, stringEnum } from "@sixb/core"
import { Organization } from "./organization"

export const Customer = defineObjectType({
  id: "Customer",
  name: "Customer",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
    prop("tier", stringEnum(["free", "team", "enterprise"])),
    prop("monthlySpend", "double", { mode: "telemetry" }),
  ],
  links: [link("belongsTo", Organization, { cardinality: "one" })],
})
```

Each object type must have exactly one primary property (`{ required: true, primary: true }`
with a `"string"` schema). It uniquely identifies each object of that type.

## Token model

Every registered object type carries two typed token maps so runtime APIs can reference
properties and links without raw string ids:

| Token | Shape | Use it for |
| --- | --- | --- |
| Property token | `Type.p.<propertyId>` | Telemetry, queries, and any API that targets a property |
| Link token | `Type.l.<linkId>` | Creating and navigating relationships |

```ts
Customer.p.monthlySpend // PropertyToken for the monthlySpend property
Customer.l.belongsTo    // LinkToken for the belongsTo relationship
```

Tokens are strongly typed against the object type's properties and links, so a typo or a
property that does not exist is a compile error. See [object querying](../objects/querying.md)
and [telemetry](../objects/telemetry.md) for how tokens are used at runtime.

## Convention

Put object types in `ontology/` and export them:

```txt
your-project/
  ontology/
    customer.ts
    organization.ts
    order.ts
  sixb.config.ts
```

`createSixb()` discovers exported object types from `ontology/` automatically. You can also
register them explicitly:

```ts
import { createSixb } from "@sixb/core"
import { Customer } from "./ontology/customer"
import { Organization } from "./ontology/organization"

export const sixb = createSixb({
  ontologies: [Customer, Organization],
})
```

See the [runtime overview](../runtime/overview.md) for the full discovery model.

## How to model your domain

Start small.

1. Pick one object your app cares about.
2. Give it an `id` primary property.
3. Add the properties users need to see or workflows need to use.
4. Add links only for relationships that matter in the app.
5. Add telemetry only for values where history matters.

Good object types are business-readable. `Customer`, `Invoice`, `Device`, `Room`, and `Task`
are usually better starting points than implementation names.

## In this section

| Page | What it covers |
| --- | --- |
| [Object types](./object-types.md) | Defining object types, primary property, inheritance |
| [Properties](./properties.md) | Static and telemetry properties, schemas, options |
| [Links](./links.md) | Relationships, cardinality, link properties, wildcards |
| [Value types](./value-types.md) | Reusable named value shapes with `defineValueType` |
| [Units and semantics](./units-and-semantics.md) | Semantic types and unit-aware numeric values |
| [Search metadata](./search-metadata.md) | Making object types and properties searchable |
