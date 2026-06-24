# Value Types & Interfaces

Three mechanisms keep an ontology DRY: **value types** share a property shape,
**interfaces** share a contract of properties and links, and **extends** lets one
object type inherit from a parent. All three compose the building blocks from
[Object Types](object-types.md), [Properties](properties.md), and [Links](links.md).

## Value Types

A value type is a named, reusable property shape. Define it once with
`defineValueType`, then point many properties at it with `valueTypeRef`. The schema
and semantics live in one place, so they stay consistent and evolve together.

```ts
import { defineValueType } from "@sixb/core/ontology"

export const MoneyAmount = defineValueType({
  id: "MoneyAmount",
  name: "Money Amount",
  description: "A monetary value, paired with a currency property.",
  schema: "double",
})
```

### `defineValueType` fields

| Field          | Type                 | Required | Description                                          |
| -------------- | -------------------- | -------- | ---------------------------------------------------- |
| `id`           | `string`             | yes      | Unique value-type id, referenced by `valueTypeRef`.  |
| `name`         | `string`             | yes      | Display name.                                        |
| `schema`       | `Schema`             | yes      | The shared shape — a primitive, enum, object, or array. |
| `description`  | `string`             | no       | Human-readable notes.                                |
| `semanticType` | `QuantitativeTypeId` | no       | A physical quantity; constrains valid units. See [Units & Semantics](units-and-semantics.md). |

> Money is modeled as an `amount` (double) plus a `currency` enum — never with
> `semanticType`/units. `semanticType` is only for physical readings; see
> [Units & Semantics](units-and-semantics.md).

When `semanticType` is set, every property that references the value type inherits
the constraint, and only units belonging to that quantity are valid.

### Referencing with `valueTypeRef`

`valueTypeRef` produces a schema you pass to `prop`. It has three forms:

```ts
import { defineObjectType, prop, valueTypeRef } from "@sixb/core/ontology"
import { MoneyAmount } from "./value-types"

export const Project = defineObjectType({
  id: "Project",
  name: "Project",
  properties: [
    // 1. Pass the value type — schema resolves inline, no registry lookup
    prop("budget", valueTypeRef(MoneyAmount)),
    // 2. Reference by id — resolved from the registered value types
    prop("forecast", valueTypeRef("MoneyAmount")),
  ],
})
```

| Form                         | When to use                                                            |
| ---------------------------- | --------------------------------------------------------------------- |
| `valueTypeRef(ValueType)`    | You have the object in scope. Schema resolves inline — no registration needed. |
| `valueTypeRef("id")`         | Reference by id; resolved against the value types in the ontology.     |
| `valueTypeRef("id", schema)` | Escape hatch: supply the resolved schema explicitly alongside the id.  |

Refs by id string must be able to resolve. Register the value type in
`defineOntology({ valueTypes: [...] })`, or rely on
[convention-based discovery](overview.md). The object form carries its own schema
and needs no registration.

## Interfaces

An interface is a reusable contract of properties and links. Define the shared
shape once, then mark object types as implementing it. Use interfaces for
cross-cutting roles a type plays — "is billable", "is auditable" — that don't fit a
single inheritance chain.

```ts
import { defineInterface, prop, link } from "@sixb/core/ontology"

export const Auditable = defineInterface({
  id: "auditable",
  name: "Auditable",
  description: "Anything that tracks who created it and when.",
  properties: [prop("createdAt", "timestamp"), prop("updatedAt", "timestamp")],
  links: [link("createdBy", "Employee", { cardinality: "one" })],
})
```

`properties` and `links` both default to `[]`.

### Implementing an interface

Object types declare what they implement by id via `implements`:

```ts
import { defineObjectType, prop } from "@sixb/core/ontology"

export const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  implements: ["auditable"],
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("number", "string"),
  ],
})
```

`implements` is a list of ids, so one type can satisfy several contracts:
`implements: ["auditable", "billable"]`.

## Inheritance with `extends`

`extends` makes an object type inherit the properties and links of a parent. Pass
the parent **object** (recommended — properties and links merge at build time) or
its **id string**.

```ts
import { defineObjectType, link, prop, stringEnum } from "@sixb/core/ontology"
import { Employee } from "./employee"
import { Project } from "./project"

export const Document = defineObjectType({
  id: "Document",
  name: "Document",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("title", "string", { required: true }),
    prop("type", stringEnum(["proposal", "contract", "specification", "report"])),
    prop("createdAt", "timestamp"),
  ],
  links: [
    link("project", Project, { cardinality: "one" }),
    link("author", Employee, { cardinality: "one" }),
  ],
})

// Inherits all Document properties and links, then adds its own.
export const Contract = defineObjectType({
  id: "Contract",
  name: "Contract",
  extends: Document,
  properties: [prop("signedAt", "timestamp"), prop("value", "double")],
})
```

`Contract.properties` is the merged set: `id`, `title`, `type`, `createdAt`,
`signedAt`, and `value`. Merge is by id, so an own definition overrides an
inherited one with the same id.

### `extends` vs `parents`

| Field     | Type                   | Purpose                                                            |
| --------- | ---------------------- | ----------------------------------------------------------------- |
| `extends` | `string \| ObjectType` | The primary structural parent. Its properties and links merge in. |
| `parents` | `string[]`             | Extra parent ids for multi-parent classification (no merge).      |

Passing an object to `extends` also records its id in `parents`. Use `parents`
when a type belongs to several classifications but inherits structure from one.

## Choosing between them

| Mechanism      | Reuses                  | Use when                                                       |
| -------------- | ----------------------- | ------------------------------------------------------------- |
| **Value type** | One property shape      | Many properties share a schema (and maybe a semantic).        |
| **Interface**  | A set of props + links  | A cross-cutting role spans otherwise unrelated types.         |
| **Extends**    | A full parent type      | A subtype is-a parent and should inherit its structure.       |

## Related

- [Object Types](object-types.md) — the primary modeling unit.
- [Properties](properties.md) — `prop`, schemas, and modes.
- [Links](links.md) — relationships between object types.
- [Units & Semantics](units-and-semantics.md) — `semanticType` and quantities.
- [Ontology overview](overview.md) — registration and discovery.
</content>
</invoke>
