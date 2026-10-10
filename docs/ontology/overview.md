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

## Explain it to the agent

Before working with a type, the [agent](../models/overview.md) reads a reference file that Sixb
writes from your definitions, limited to what the person it works for can see.

Add what your definitions cannot say, such as business rules or vocabulary, in a Markdown file next
to the module that defines the type, with the same name. Sixb adds it to the reference file:

```md
<!-- ontology/invoice.md, next to ontology/invoice.ts -->
An invoice is overdue 30 days after it is sent, not after its due date.
```

Put work the agent would otherwise rebuild on every question, such as a search that combines
several queries or a calculation over a type's data, in a `scripts/` folder anywhere under
`ontology/`. The agent runs these files in its sandbox, where they query the project with the
`sixb` CLI as the person it works for. They are never loaded as definitions. Point to them from
the type's notes:

```md
<!-- ontology/support/ticket.md -->
To search a customer's tickets, run
`bun $SIXB_ONTOLOGY_DIR/support/scripts/search-history.ts <customerId> "<question>"`.
It combines keyword and meaning search and prints the best tickets first.
```

Continue with [Object types](object-types.md) to define your first type, [Properties](properties.md)
to choose its values and query capabilities, or [Links](links.md) to connect it to other types.
