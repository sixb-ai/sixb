# Search & Query Metadata

Sixb validates every query against your ontology. A property is **not** queryable just because it
exists — you opt each field into query surfaces with `query` metadata, and you set a `search`
profile on the object type for keyword and vector search. This page covers both. For the query API
itself, see [Querying Objects](../objects/querying.md).

## Property Query Metadata

Set `query` on a property to expose it to queries. `searchable` is the gate: every other flag
(and `weight`) requires `searchable: true` on the same property, or `validate()` rejects the
ontology.

```ts
import { defineObjectType, link, prop, stringEnum } from "@sixb/core/ontology"
import { Customer } from "./customer"
import { Project } from "./project"

export const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("number", "string", {
      required: true,
      query: { searchable: true, filterable: true, exact: true, sortable: true },
    }),
    prop("amount", "double", {
      required: true,
      query: { searchable: true, filterable: true, sortable: true },
    }),
    prop("currency", stringEnum(["EUR", "USD", "GBP"]), {
      query: { searchable: true, filterable: true, exact: true, facet: true },
    }),
    prop("status", stringEnum(["draft", "sent", "paid", "overdue", "cancelled"]), {
      query: { searchable: true, filterable: true, exact: true, facet: true },
    }),
    prop("issuedAt", "timestamp", {
      query: { searchable: true, filterable: true, sortable: true },
    }),
    prop("dueDate", "date", {
      query: { searchable: true, filterable: true, sortable: true },
    }),
  ],
  search: {
    title: "number",
    exact: ["id", "number"],
  },
  links: [
    link("customer", Customer, { cardinality: "one" }),
    link("project", Project, { cardinality: "one" }),
  ],
})
```

| Flag | Type | Enables |
| --- | --- | --- |
| `searchable` | `boolean` | Required gate. Must be `true` before any other flag (or `weight`) applies. |
| `filterable` | `boolean` | `where(...)` predicates: `eq`, `neq`, ranges, `in`, `exists`, `contains`. |
| `sortable` | `boolean` | `orderBy(...)` on the property. |
| `text` | `boolean` | Keyword search over the property via `search(...)`. String-like schemas only. |
| `exact` | `boolean` | Exact-match search profiles such as `search.exact`. |
| `facet` | `boolean` | `facets(...)` bucket counts. Field must also be exact-matchable. |
| `vector` | `boolean` | Vector search on numeric-array embedding fields, when the provider supports it. |
| `weight` | `number` | Positive relative weight for text ranking. Only valid with `text: true`. |

### Which schemas support which flag

Each flag is checked against the property's schema at validation time:

| Flag | Allowed schemas |
| --- | --- |
| `filterable` | exact-matchable schemas, plus `array` and `map` |
| `sortable` | `string`, `uuid`, `integer`, `double`, `decimal`, `date`, `timestamp`, enums |
| `text` | `string` and string enums |
| `exact` | any primitive schema except `fileRef` (so not `object`/`array`/`map`), plus enums |
| `facet` | same as `exact` |
| `vector` | numeric arrays (`integer`, `double`, or `decimal` items) |

Predicate values are still type-checked against the property schema when the query runs. See
[Properties](./properties.md) for the full schema list.

## Object-Type Search Profile

The `search` config picks which fields a global or type-scoped search uses.

```ts
search: {
  title: "company",
  defaultText: ["company", "name", "industry"],
  exact: ["id", "email", "company"],
}
```

| Field | Type | Purpose |
| --- | --- | --- |
| `title` | `string` | Display/title property shown in search results. Must be string-like. |
| `defaultText` | `string[]` | Default keyword-search fields when `search("...")` is called without `fields`. |
| `exact` | `string[]` | Exact-match fields such as external ids, emails, or invoice numbers. |
| `vector` | `{ property, source }` | Vector search: `property` stores the embedding, `source` lists the text fields used to produce it. |

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

## How Metadata Drives Queries

| Query call | Required metadata |
| --- | --- |
| `where((o) => o.p.status.eq(...))` | `status`: `searchable` + `filterable` |
| `orderBy(Invoice.p.amount, "desc")` | `amount`: `searchable` + `sortable` |
| `search("acme")` | `search.defaultText` fields with `searchable` + `text` |
| `search("acme", { fields: [Customer.p.company] })` | `company`: `searchable` + `text` |
| `facets([{ property: Invoice.p.status, limit }])` | `status`: `searchable` + `facet` (exact-matchable) |
| vector search | embedding field: `searchable` + `vector`, plus `search.vector.property` |

Missing or mismatched metadata is caught when you call `validate()` — it reports unknown
properties, wrong value types, missing query flags, invalid text fields, and unsupported
traversals before any query runs. Provider capability gaps (vector search, relevance sorting)
surface at execution time.

## Related

- [Querying Objects](../objects/querying.md) — the fluent query builder and predicates.
- [Properties](./properties.md) — property schemas and options.
- [Object Types](./object-types.md) — defining object types.
- [Client Typed Queries](../client/typed-queries.md) — running these queries from the browser.
