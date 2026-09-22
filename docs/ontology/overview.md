# Ontology

An ontology is the shared model of your domain. It defines the things your software works with,
the information they hold, and how they relate. Your apps, agents, and automation all use this model.

## Define your model

An **object type** describes a kind of thing, such as an invoice. An **object** is one instance,
such as invoice `inv-001`. Properties hold its values; links connect it to other objects.

Export your definitions from `ontology/`. Sixb discovers them automatically. This example defines
customers and invoices, with a link from each invoice to its customer:

```ts
// ontology/billing.ts
import { defineObjectType, link, prop, stringEnum } from "@sixb/core/ontology"

export const Customer = defineObjectType({
  id: "Customer",
  name: "Customer",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
  ],
})

export const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("number", "string", { required: true }),
    prop("status", stringEnum(["draft", "sent", "paid"])),
  ],
  links: [link("customer", Customer, { cardinality: "one" })],
})
```

Each type needs one required string property as its primary ID. The `customer` link describes
which relationships an invoice can have; it does not create a customer or connect any objects yet.

Import these builders from `@sixb/core/ontology` so your definitions can also be used in browser code.
As the model grows, you can split its types into separate files.

## Bring the model to life

Definitions describe the model. Create its objects through [code](../objects/overview.md), or map
rows from your datasets with [projections](../projections/overview.md). Datasets hold source and
transformed rows; the ontology gives that data the types and relationships your software uses.

The same `Invoice` definition then gives your [app](../apps/querying-data.md) typed queries and
connects [actions](../actions/overview.md) to invoices. Agents and workflows can use those actions
to make changes. You define each type and operation once, and reuse them across your project.

Continue with [Object types](object-types.md) to define your first type, [Properties](properties.md)
to choose its values and query capabilities, or [Links](links.md) to connect it to other types.
