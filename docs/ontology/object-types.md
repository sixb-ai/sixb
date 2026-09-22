# Object types

An object type defines the properties and relationships shared by one kind of thing in your
domain. Each object of that type has its own identity and values.

## Define a type

Export a `defineObjectType()` definition from `ontology/`. This example uses the `Customer`
type from the [overview](overview.md), placed in `ontology/customer.ts`:

```ts
// ontology/invoice.ts
import { defineObjectType, link, prop, stringEnum } from "@sixb/core/ontology"
import { Customer } from "./customer"

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

| Field | Purpose |
| --- | --- |
| `id` | Stable identifier, unique across your project's object types. |
| `name` | Display name. |
| `description` | Optional explanation of what the type represents. |
| `properties` | Values each object can hold. See [Properties](properties.md). |
| `links` | Relationships it can have. See [Links](links.md). |
| `search` | Keyword-search fields and vector profiles. See [Configure search](properties.md#configure-search). |
| `extends` | An optional parent type to inherit from. |

Use domain names such as `Invoice` or `Satellite`. Keep type and property IDs stable; display
names can change independently.

## Give objects an identity

Every type must have exactly one primary property. It must use the `"string"` schema with both
`required: true` and `primary: true`:

```ts
prop("id", "string", { required: true, primary: true })
```

The property does not have to be named `id`. Its value identifies one object within the type:
`Invoice` and `Customer` can each have an object with ID `001`.

## Reference properties and links

Definitions expose typed references for use in queries, telemetry, and relationship operations:

```ts
Invoice.p.status
Invoice.l.customer
```

TypeScript checks these names against the definition. See [Objects](../objects/overview.md) for
reading and writing instances, and [Querying](../objects/querying.md) for filtering and following links.

## Extend a type

Use `extends` when one type is a specialization of another. Pass the imported parent definition
to inherit its properties, links, and TypeScript types:

```ts
// ontology/credit-note.ts
import { defineObjectType, prop } from "@sixb/core/ontology"
import { Invoice } from "./invoice"

export const CreditNote = defineObjectType({
  id: "CreditNote",
  name: "Credit note",
  extends: Invoice,
  properties: [prop("reason", "string", { required: true })],
})
```

`CreditNote` inherits the primary ID, invoice properties, and customer link, and adds `reason`.
A child property or link with the same ID replaces the parent's definition. The parent must also
be exported from `ontology/` so Sixb can discover it.

To reuse a value such as an address across otherwise unrelated types, use a [value type](value-types.md).
