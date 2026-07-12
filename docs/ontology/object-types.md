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
| `search` | No | A search profile for this type. See [search metadata](./search-metadata.md). |
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

There is no "explicitly not primary" value — non-primary properties simply omit the flag. See
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

## Search

The optional `search` field declares which fields a global or type-scoped search uses.

```ts
search: {
  title: "company",
  defaultText: ["company", "name", "industry"],
  exact: ["id", "email", "company"],
}
```

| Field | Expected | Meaning |
| --- | --- | --- |
| `title` | `string` | Display/title property used in search results |
| `defaultText` | `string[]` | Default keyword-search fields for this type |
| `exact` | `string[]` | Exact-match fields such as ids, slugs, or emails |
| `vector` | `{ property, source }` | Vector-search configuration for semantic retrieval |

Per-property indexing flags (`searchable`, `filterable`, `exact`, `facet`, and others) live on
each property's `query` option. The full surface is documented in
[search metadata](./search-metadata.md).

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

## Registration

### By convention

Put each object type in `ontology/` and export it. `createSixb()` discovers exported object
types automatically — this is the normal registration model.

```txt
your-project/
  ontology/
    customer.ts
    employee.ts
    invoice.ts
    project.ts
  sixb.config.ts
```

### Explicit array

You can also register object types explicitly with the `ontologies` option:

```ts
import { createSixb } from "@sixb/core"
import { Customer } from "./ontology/customer"
import { Invoice } from "./ontology/invoice"

export const sixb = await createSixb({
  ontologies: [Customer, Invoice],
})
```

`createSixb()` is async — `await` it. See the [runtime overview](../runtime/overview.md) for how
discovery and `createSixb()` fit together.

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
- [Search metadata](./search-metadata.md) — per-property indexing and search profiles
- [Objects](../objects/overview.md) — CRUD, querying, and telemetry on registered types
