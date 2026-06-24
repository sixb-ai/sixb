# Object Types

An object type is one kind of thing in your domain, such as `Customer`, `Order`, or `Device`.
It declares the [properties](./properties.md) the object has and the [links](./links.md) it can
make to other object types.

Define object types with `defineObjectType`. For the wider model, see the
[ontology overview](./overview.md).

## defineObjectType

File: `ontology/customer.ts`

```ts
import { defineObjectType, link, prop, stringEnum } from "@sixb/core"
import { Employee } from "./employee"

export const Customer = defineObjectType({
  id: "Customer",
  name: "Customer",
  description: "A company customer.",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
    prop("email", "string"),
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
| `search` | No | A search profile for this object type. See [search metadata](./search-metadata.md). |
| `extends` | No | A parent object type (or its id) to inherit properties and links from |
| `parents` | No | Additional parent type ids for multi-parent classification |
| `implements` | No | Interface ids this type satisfies |
| `quantityKind` | No | The physical quantity a sensor/point type measures |
| `seeAlso` | No | External documentation or reference URLs |

The return value carries typed token maps used elsewhere in the API:

| Token map | Use |
| --- | --- |
| `Customer.p` | Property tokens, e.g. `Customer.p.email`, used for telemetry and queries |
| `Customer.l` | Link tokens, e.g. `Customer.l.accountManager`, used when creating links |

## The primary property rule

Each object type must have exactly one primary property. It uniquely identifies each object
instance within its type.

Mark it with `{ required: true, primary: true }` on a `"string"` property:

```ts
prop("id", "string", { required: true, primary: true })
```

Only `primary: true` is accepted — there is no "explicitly not primary" value. See
[properties](./properties.md) for the full `prop(...)` reference.

## Properties and links

`properties` describe what the object knows. `links` describe how it relates to other object
types. Both are arrays built with the `prop(...)` and `link(...)` helpers.

```ts
export const Customer = defineObjectType({
  id: "Customer",
  name: "Customer",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
    prop("activeSeats", "integer", { mode: "telemetry" }),
  ],
  links: [link("accountManager", Employee, { cardinality: "one" })],
})
```

- Properties are detailed in [properties](./properties.md), including static vs. telemetry
  values and `semanticType`.
- Links are detailed in [links](./links.md), including targets, cardinality, and link
  properties.

## Search

The optional `search` field declares which fields a global or type-scoped search uses.

```ts
export const Customer = defineObjectType({
  id: "Customer",
  name: "Customer",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
    prop("company", "string", { required: true }),
    prop("email", "string", { required: true }),
    prop("industry", "string"),
  ],
  search: {
    title: "company",
    defaultText: ["company", "name", "industry"],
    exact: ["id", "email", "company"],
  },
})
```

| Field | Expected | Meaning |
| --- | --- | --- |
| `title` | `string` | Display/title property used in search results |
| `defaultText` | `string[]` | Default keyword-search fields for this type |
| `exact` | `string[]` | Exact-match fields such as ids, slugs, or emails |
| `vector` | `{ property, source }` | Vector-search configuration for semantic retrieval |

Per-property indexing flags (`searchable`, `filterable`, `text`, and others) live on each
property's `query` option. The full surface is documented in
[search metadata](./search-metadata.md).

## extends (inheritance)

`extends` inherits all properties and links from a parent object type. The child adds its own
fields on top; same-id properties or links from the child override the parent's.

```ts
import { defineObjectType, prop } from "@sixb/core"
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

`Contract` here has every `Document` property and link plus its own three properties.

`extends` accepts either the parent object type (as above) or its id string. The parent id is
recorded on `parents`; use `parents` directly to record additional parent types for
multi-parent classification without merging their fields.

## Registration

### By convention

Put object types in `ontology/` and export them. `createSixb()` discovers exported object
types automatically.

```txt
your-project/
  ontology/
    customer.ts
    organization.ts
    order.ts
  sixb.config.ts
```

### Explicit array

You can also register object types explicitly:

```ts
import { createSixb } from "@sixb/core"
import { Customer } from "./ontology/customer"
import { Organization } from "./ontology/organization"

export const sixb = createSixb({
  ontology: [Customer, Organization],
})
```

See the [runtime overview](../runtime/overview.md) for how discovery and `createSixb()` fit
together.

## Use the object type

Once registered, access objects through the typed API with `sixb.objects(Type)`:

```ts
import { Customer } from "./ontology/customer"

const customers = sixb.objects(Customer)

await customers.upsert({
  properties: {
    id: "cust-001",
    name: "Acme Corp",
    email: "team@acme.example",
    tier: "gold",
  },
})

const customer = await customers.get("cust-001")
```

TypeScript understands the properties and links from your object type. For reads, writes,
telemetry, and links, see [objects](../objects/overview.md).
