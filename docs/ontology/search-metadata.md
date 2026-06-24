# Search & Query Metadata

Sixb validates queries against your ontology. Properties are not queryable just because they
exist — you declare query metadata on the fields you want to filter, sort, or search, and a
search profile on the object type. This page covers both. For the query API itself, see
[Querying Objects](../objects/querying.md).

## Property Query Metadata

Set `query` on a property to opt it into query surfaces. `searchable` is the gate: every other
flag requires `searchable: true` on the same property.

```ts
import { defineObjectType, link, prop, stringEnum } from "@sixb/core"
import { Customer } from "./customer"

export const Project = defineObjectType({
  id: "Project",
  name: "Project",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", {
      required: true,
      query: { searchable: true, text: true, exact: true, sortable: true, weight: 5 },
    }),
    prop("description", "string", {
      query: { searchable: true, text: true },
    }),
    prop("status", stringEnum(["draft", "active", "paused", "completed"]), {
      query: { searchable: true, filterable: true, exact: true, facet: true },
    }),
    prop("deadline", "date", {
      query: { searchable: true, filterable: true, sortable: true },
    }),
    prop("budget", "double", {
      query: { searchable: true, filterable: true, sortable: true },
    }),
  ],
  search: {
    title: "name",
    defaultText: ["name", "description"],
    exact: ["id", "name"],
  },
  links: [link("customer", Customer, { cardinality: "one" })],
})
```

| Flag | Type | Enables |
| --- | --- | --- |
| `searchable` | `boolean` | Required gate. Must be `true` before any other flag applies. |
| `filterable` | `boolean` | `where(...)` predicates: `eq`, `neq`, ranges, `in`, `exists`, `contains`. |
| `sortable` | `boolean` | `orderBy(...)` on the property. |
| `text` | `boolean` | `.search(...)` keyword search over the property. String-like schemas only. |
| `exact` | `boolean` | Exact-match search profiles such as `search.exact`. Primary ids are exact-matchable by default. |
| `facet` | `boolean` | `.facets(...)` bucket counts. Field must also be exact-matchable. |
| `vector` | `boolean` | Vector search on numeric-array embedding fields when the provider supports it. |
| `weight` | `number` | Relative text-search weight for ranking providers. Only meaningful with `text: true`. |

Predicate values are still checked against the property schema. Range predicates and sorting
work on orderable schemas — strings, numbers, dates, timestamps, uuids, and enums. See
[Properties](./properties.md) for schema types.

## Object-Type Search Profile

The object-type `search` config decides which fields a global or type-scoped search uses.

```ts
search: {
  title: "name",
  defaultText: ["name", "description"],
  exact: ["id", "name"],
}
```

| Field | Type | Purpose |
| --- | --- | --- |
| `title` | `string` | Display/title property used in search results. |
| `defaultText` | `string[]` | Default fields for `.search("...")` when no `fields` are given. |
| `exact` | `string[]` | Exact-match fields such as external ids, slugs, or emails. |
| `vector` | `{ property, source }` | Vector-search config: `property` stores the embedding, `source` lists the text properties used to produce it. |

Fields referenced by the profile must carry the matching property flag — `defaultText` fields
need `text: true`, `exact` fields need `exact: true`, the `vector.property` needs `vector: true`,
and each `vector.source` field needs `text: true`. Primary ids remain exact-matchable even when
omitted from `exact`.

```ts
search: {
  title: "name",
  defaultText: ["name", "description"],
  vector: { property: "embedding", source: ["name", "description"] },
}
```

## How It Drives Queries

| Query call | Required metadata |
| --- | --- |
| `where((o) => o.p.x.eq(...))` | `x`: `searchable` + `filterable` |
| `orderBy(Type.p.x, ...)` | `x`: `searchable` + `sortable` |
| `search("...")` | `search.defaultText` fields with `searchable` + `text` |
| `search("...", { fields: [Type.p.x] })` | `x`: `searchable` + `text` |
| `facets([{ property: Type.p.x, limit }])` | `x`: `searchable` + `facet` (and exact-matchable) |
| vector search | `x`: `searchable` + `vector`, plus `search.vector.property` |

Missing metadata is caught at validation time — `validate()` reports unknown properties, wrong
value types, missing query flags, invalid text fields, and unsupported traversals before the
query runs. Provider capability gaps (vector search, relevance sorting) surface at execution.

## Related

- [Querying Objects](../objects/querying.md) — the fluent query builder and predicates.
- [Properties](./properties.md) — property schemas and options.
- [Object Types](./object-types.md) — defining object types.
- [Client Typed Queries](../client/typed-queries.md) — running these queries from the browser.
