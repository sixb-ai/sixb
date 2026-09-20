# Value Types & Interfaces

Use **value types** to reuse a property schema. Use **interfaces** to label shared roles across
object types. To inherit properties and links, see [object-type inheritance](object-types.md#extends-inheritance).

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
    prop("id", "string", { required: true, primary: true }),
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

An interface **classifies** the cross-cutting roles a type plays — "is auditable", "is billable" —
that don't fit a single inheritance chain. Unlike value types and `extends`, an interface does
**not** add structure: it is declarative classification metadata, not code reuse.

For example, `Invoice` and `Campaign` may both be labeled `auditable` without sharing a parent.
Unlike a TypeScript interface, `defineInterface` does not enforce a contract: declaring
`implements: ["auditable"]` neither adds fields nor checks that they exist.
Use [`extends`](object-types.md#extends-inheritance) when you need inherited fields.

Define the role and optionally document its expected fields:

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

`properties` and `links` describe the intended contract for readers and tooling (both default to
`[]`); Sixb does **not** inject them into implementing types or validate that a type satisfies them.

### Implementing an interface

Object types declare the roles they play by id via `implements`:

```ts
import { defineObjectType, prop } from "@sixb/core/ontology"

export const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  implements: ["auditable"],
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("number", "string"),
    // Declare the interface's members yourself — they are not inherited.
    prop("createdAt", "timestamp"),
    prop("updatedAt", "timestamp"),
  ],
})
```

`implements` is a plain list of ids recorded on the object type, so one type can carry several
roles: `implements: ["auditable", "billable"]`. Because it is classification only, the interface's
`createdAt`/`updatedAt`/`createdBy` members must still be declared on each implementing type (or
inherited via [`extends`](object-types.md#extends-inheritance)). Reach for an interface when you want a shared
**label**; reach for `extends` when you want shared **structure**.

## Choosing between them

| Mechanism      | Reuses                  | Use when                                                       |
| -------------- | ----------------------- | ------------------------------------------------------------- |
| **Value type** | One property shape        | Many properties share a schema (and maybe a semantic).        |
| **Interface**  | Nothing — classification  | You want to label a cross-cutting role; each type still declares its own structure. |
| **Extends**    | A full parent type        | A subtype is-a parent and should inherit its structure.       |

## Related

- [Object Types](object-types.md) — the primary modeling unit.
- [Properties](properties.md) — `prop`, schemas, and modes.
- [Links](links.md) — relationships between object types.
- [Units & Semantics](units-and-semantics.md) — `semanticType` and quantities.
- [Ontology overview](overview.md) — registration and discovery.
