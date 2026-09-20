# Object Types

An object type is one kind of thing in your domain, such as `Customer`, `Invoice`, or
`Project`. It declares the [properties](./properties.md) the object has and the
[links](./links.md) it makes to other object types.

Define object types with `defineObjectType`. Reach for them whenever you need a first-class,
queryable entity with typed properties and relationships. For the wider model, see the
[ontology overview](./overview.md).

## defineObjectType

Import builders from `@sixb/core/ontology`. Each object type lives in its own file under
`ontology/`.

```ts
import { defineObjectType, link, prop, stringEnum } from "@sixb/core/ontology"
import { Employee } from "./employee"

export const Customer = defineObjectType({
  id: "Customer",
  name: "Customer",
  description: "A company customer.",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
    prop("email", "string", { required: true }),
    prop("company", "string", { required: true }),
    prop("industry", "string"),
    prop("tier", stringEnum(["bronze", "silver", "gold", "platinum"])),
  ],
  links: [link("accountManager", Employee, { cardinality: "one" })],
})
```

`defineObjectType(input)` accepts these fields:

| Field | Required | Expected |
| --- | --- | --- |
| `id` | Yes | A stable type id, unique within the ontology |
| `name` | Yes | Display name for the object type |
| `description` | No | Human-readable context for the type |
| `properties` | No | An array of `prop(...)` definitions. Defaults to `[]`. |
| `links` | No | An array of `link(...)` definitions. Defaults to `[]`. |
| `search` | No | A search profile for this type. See [search profile](#object-type-search-profile). |
| `extends` | No | A parent object type (or its id) to inherit properties and links from |
| `parents` | No | Additional parent type ids for multi-parent classification |
| `implements` | No | Interface role ids this type is classified under. See [Interfaces](./value-types.md#interfaces). |
| `quantityKind` | No | The physical quantity a sensor/point type measures (a `QuantitativeTypeId`). See [Units & Semantics](./units-and-semantics.md). |
| `seeAlso` | No | External reference URLs (`string[]`) for documentation. |

The return value carries typed token maps used elsewhere in the API:

| Token map | Use |
| --- | --- |
| `Customer.p` | Property tokens, e.g. `Customer.p.email`, used for telemetry and queries |
| `Customer.l` | Link tokens, e.g. `Customer.l.accountManager`, used when creating links |

## The primary property rule

Each object type must have **exactly one** primary property. It uniquely identifies each
object instance within its type.

Mark it with `{ required: true, primary: true }` on a `"string"` property:

```ts
prop("id", "string", { required: true, primary: true })
```

Omit the flag on other properties. See
[properties](./properties.md) for the full `prop(...)` reference, including static vs. telemetry
values, enums, and per-property `query` metadata.

## Links

`links` describe how an object relates to other object types. Each `link(...)` names the
relationship, points at a target type, and sets a `cardinality` of `"one"` or `"many"`.

```ts
import { defineObjectType, link, prop, stringEnum } from "@sixb/core/ontology"
import { Customer } from "./customer"
import { Employee } from "./employee"

export const Project = defineObjectType({
  id: "Project",
  name: "Project",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
    prop("status", stringEnum(["draft", "active", "paused", "completed", "cancelled"])),
    prop("budget", "double"),
    prop("progress", "integer", { mode: "telemetry" }),
  ],
  links: [
    link("customer", Customer, { cardinality: "one" }),
    link("lead", Employee, { cardinality: "one" }),
    link("members", Employee, { cardinality: "many" }),
  ],
})
```

Targets, cardinality, and link properties are covered in full on the [links](./links.md) page.

## Object-Type Search Profile

`search` tells Sixb where to look when someone searches for text. For example, searching for
`"Acme"` on `Customer` checks `company`, `name`, and `industry` with this configuration:

```ts
search: {
  title: "company",
  defaultText: ["company", "name", "industry"],
  exact: ["id", "email", "company"],
}
```

The same profile applies whether you search only `Customer` objects or search across several
object types. Each type supplies its own fields. It does not change which fields are returned.

| Field | Type | Purpose |
| --- | --- | --- |
| `title` | `string` | Display/title property shown in search results. Must be string-like. |
| `defaultText` | `string[]` | Default keyword-search fields when `search("...")` is called without `fields`. |
| `exact` | `string[]` | Exact-match fields such as external ids, emails, or invoice numbers. |
| `vector` | `{ property, source }` | Vector search: `property` stores the embedding, `source` lists the text fields used to produce it. |

Configure [query flags](properties.md#property-query-metadata) on each referenced property.
Every field a profile references must carry the matching property flag:

- `defaultText` fields need `text: true`
- `exact` fields need `exact: true` (the primary id is always exact-matchable, so it's exempt)
- `vector.property` needs `vector: true`, and each `vector.source` field needs `text: true`

Search profiles can only reference **static** properties — telemetry properties (such as
`Project.progress`) are not object-query indexed and will fail validation here.

For vector search, add an embedding property (a numeric array carrying `query.vector: true`) and
point `search.vector` at it. The `source` fields must each carry `text: true`.

```ts
search: {
  title: "name",
  defaultText: ["name", "description"],
  vector: { property: "embedding", source: ["name", "description"] },
}
```

## extends (inheritance)

`extends` inherits all properties and links from a parent object type. The child adds its own
fields on top; a child property or link reusing a parent id overrides the parent's.

```ts
import { defineObjectType, prop } from "@sixb/core/ontology"
import { Document } from "./document"

export const Contract = defineObjectType({
  id: "Contract",
  name: "Contract",
  description: "A signed contract document with binding terms.",
  extends: Document,
  properties: [
    prop("signedAt", "timestamp"),
    prop("expiresAt", "date"),
    prop("value", "double"),
  ],
})
```

`Contract` has every `Document` property and link plus its own three. `extends` accepts either
the parent object type (as above) or its id string. The parent id is recorded on `parents`; use
`parents` directly to record additional parent types for multi-parent classification without
merging their fields.

## File location

Export definitions from `ontology/`. See [Project structure](../fundamentals/project-structure.md) for discovery rules.

## Use the object type

Once registered, access objects through the typed API with `sixb.objects(Type)`. The primary id
goes inside `properties` — there is no separate key field.

```ts
import { Customer } from "./ontology/customer"

const customers = sixb.objects(Customer)

await customers.upsert({
  properties: {
    id: "cust-001",
    name: "Acme Corp",
    email: "team@acme.example",
    company: "Acme Corp",
    tier: "gold",
  },
})

const customer = await customers.get("cust-001")
```

TypeScript infers the properties and links from your object type. For reads, writes, telemetry,
and links, see [objects](../objects/overview.md).

## Related

- [Properties](./properties.md) — the `prop(...)` reference, telemetry, and query metadata
- [Links](./links.md) — relationships, cardinality, and link properties
- [Objects](../objects/overview.md) — CRUD, querying, and telemetry on registered types
