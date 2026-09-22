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
| `vectors` | Named profiles | Derived embeddings with sources and a model; see [named vector profiles](#named-vector-profiles). |

Configure [query flags](properties.md#property-query-metadata) on each referenced property.
Keyword and exact-match fields must carry the matching property flag:

- `defaultText` fields need `text: true`
- `exact` fields need `exact: true` (the primary id is always exact-matchable, so it's exempt)
- `vectors` sources need no query flag; they must be static text properties

Search profiles can only reference **static** properties — telemetry properties (such as
`Project.progress`) are not object-query indexed and will fail validation here.

## Named vector profiles

`search.vectors` defines **one vector per object and named profile**, outside business properties.
Sources must be static strings or string enums; keyword-search flags are unnecessary.

```ts
search: {
  vectors: {
    content: { source: ["title", "description"], model: productEmbedding },
    context: { source: ["context"], model: productEmbedding },
  },
}
```

Register the same `EmbeddingModel` in `models.embedding: [productEmbedding]`; language models
are optional. Vercel Gateway provides `gateway.embedding(modelId, { dimensions })`.

```ts
const { objects } = await sixb.objects(Product)
  .query()
  .vector("content", "lightweight running shoes", { k: 10 })
  .list()
// k: return at most 10 nearest objects among eligible, authorized candidates.
// objects[i].score: cosine similarity, highest first.
```

During projections, Sixb automatically generates and updates embeddings when a profile's source
properties change. Generation runs in the background; updated objects become searchable through
that profile once their embedding is ready. Compatible objects are embedded in batches when the
provider supports it, without additional configuration. Profile names are autocompleted.

Adding or changing a profile does not reindex existing objects. To explicitly index or retry an
object, use `await sixb.objects(Product).byId("product-1").vector("content").index()`.

The same query works with `objects(Product)` from `@sixb/client/query`: text is embedded on the
server with the profile's registered model, after validation and authorization. Each terminal
execution makes one embedding call; `validate()` and `explain()` make none. Query embeddings are
not stored. Text must be nonempty and at most 8,000 characters. The model receives a 30-second
abort signal; `.list({ signal })` also forwards caller cancellation. Providers must honor it.
Search accepts text only. Numeric vectors are generated internally with the profile's model.

| Guarantee | Behavior |
| --- | --- |
| Freshness | Source changes invalidate affected profiles atomically, including projections and reset. Deletion removes all profiles. Unrelated changes preserve stored vectors. |
| Compatibility | Source order, model identity or dimension changes exclude old vectors. Model identities must represent stable embedding semantics. |
| Object lifecycle | Reindexing changes neither the object's version nor its events. Failed commits roll back vectors and objects together. |
| Numeric validity | Unit-length float32, 1–16,000 dimensions, finite values and nonzero norm after rounding; malformed vectors are rejected. |
| Authorization | All sources must be readable. Candidates are authorized before ranking; ties use object type/id. |
| Accounting | Indexing and text search share [usage, cost and limits](../models/usage-and-limits.md#embeddings). Completed calls are recorded even when vector validation or the object write fails. |
| Query bounds | One profile and concrete type; `where` before ranking, `limit` after (`project` in JSON IR). `k`: 1–1,000. Counts, facets and `total` describe the selected top-k. |

V1 excludes pagination, traversal, expansion, subtype search, hybrid search and profile fusion.
**Persistence:** `InMemoryStorage`, `PostgresStorage` and `SqliteStorage` support named profiles.
PostgreSQL uses native arrays and SQLite uses float32 blobs, without search extensions for storage.
**Search:** memory, PostgreSQL with [pgvector](../../storage/pg/README.md#vector-profiles), and
SQLite with [sqlite-vec](../../storage/sqlite/README.md#vector-profiles). SQL search rejects more
than 10,000 eligible vectors or 16 million coordinates; narrow filters if the bound is exceeded.
Vectors are normalized internally for cosine comparison. Numeric-array properties are ordinary
business data; vector search only uses named profiles.

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
