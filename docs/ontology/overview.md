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

The [agent](../models/overview.md) reads a reference file for each type before working with it.
Sixb writes the file from your definitions, at the start of each run, with only what the person the
agent works for can see: the type's description, its properties and how each can be queried, its
vector search profiles, its links in both directions, and its actions. A type they cannot see, or a
property hidden by a [marking](../auth/markings.md), is left out.

Add what your definitions cannot say, such as business rules or vocabulary, in a Markdown file at
the path of the type's reference file. Sixb appends it under "Project notes":

- A module that defines one type: next to the module, with the same name. Notes for a type in
  `ontology/invoice.ts` go in `ontology/invoice.md`.
- A module that defines several types: one file per type, in a folder named after the module. The
  `billing.ts` module above gives `ontology/billing/Customer.md` and `ontology/billing/Invoice.md`.
  Notes in `ontology/billing.md` apply to both and are appended to each.

```md
<!-- ontology/billing/Invoice.md -->
An invoice is overdue 30 days after it is sent, not after its due date.
Only invoices with status `sent` can be reminded.
```

A type exported from several modules, for example through an `index.ts` that re-exports others,
belongs to the module named after it (`email-thread.ts` for `EmailThread`). Notes reach only the
people who can see their type. Two files whose paths only differ by case stop your project from
loading, since the agent's sandbox may not tell them apart.

Other Markdown files under `ontology/` are given to the agent as written, whoever it works for, so
keep restricted information in the notes of a type. Files in a `scripts/` folder anywhere under
`ontology/` are also given to the agent, with their permissions, and are never loaded as
definitions: reference them from your notes. Dotfiles and `node_modules`, `venv`, or `__pycache__`
folders are left out, and these files are limited to 16 MB in total. In `sixb dev`, saving one of
them restarts your project.

Continue with [Object types](object-types.md) to define your first type, [Properties](properties.md)
to choose its values and query capabilities, or [Links](links.md) to connect it to other types.
