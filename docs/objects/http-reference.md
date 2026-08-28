# HTTP & Raw Queries

Object queries travel over HTTP as a raw query IR: a tree of nested nodes. Most application
code uses the fluent API (see [querying](./querying.md)) — reach for raw JSON when you call the
HTTP routes directly, use a generated client, or build queries outside TypeScript.

The browser builder in `@sixb/client/query` produces this exact IR and posts it to these routes
for you. See [typed queries](../client/typed-queries.md) for the type-checked path.


## Routes

Every route accepts a JSON body with a top-level `query` node and validates it against the
registered ontology.

| Route | Body | Returns |
| --- | --- | --- |
| `POST /api/objects/query` | `{ query, includeTotal? }` | `{ objects, hasMore, nextPageToken?, total?, plan }` |
| `POST /api/objects/query/count` | `{ query }` | `{ count, plan }` |
| `POST /api/objects/query/exists` | `{ query }` | `{ exists, plan }` |
| `POST /api/objects/query/facets` | `{ query, facets }` | `{ facets, plan }` |

The query route includes `total` by default. Set `includeTotal: false` to omit the full matching
count when it is not needed, because counting can be more expensive than fetching a page.

Every response carries a diagnostic `plan` object for debugging. Application code ignores it and
reads the result fields above. Validation and planning failures return HTTP 400 with a structured
`issues` array (the client surfaces these as `SixbQueryError`).


## Raw Query JSON

Nodes nest through an `input` field, innermost-first. This query starts with `Invoice`, filters,
sorts, limits, and projects the returned properties:

```json
{
  "query": {
    "kind": "project",
    "properties": ["id", "number", "amount", "status"],
    "input": {
      "kind": "limit",
      "limit": 20,
      "input": {
        "kind": "sort",
        "fields": [{ "kind": "property", "propertyId": "amount", "direction": "desc" }],
        "input": {
          "kind": "filter",
          "predicate": {
            "op": "and",
            "items": [
              { "op": "eq", "propertyId": "status", "value": "overdue" },
              { "op": "gte", "propertyId": "amount", "value": 5000 }
            ]
          },
          "input": { "kind": "start", "objectTypeId": "Invoice" }
        }
      }
    }
  }
}
```

Each object in the response carries its primary id, type, properties, and timestamps:

```json
{
  "objects": [
    {
      "primaryId": "inv-1042",
      "objectTypeId": "Invoice",
      "properties": { "id": "inv-1042", "number": "2026-1042", "amount": 8200, "status": "overdue" },
      "createdAt": "2026-05-01T09:00:00.000Z",
      "updatedAt": "2026-06-10T12:30:00.000Z"
    }
  ],
  "hasMore": false,
  "plan": { "mode": "pushdown" }
}
```


## Exact Object References

Use a `refs` source when object identities are already known. References can be heterogeneous,
primary ids remain in JSON rather than URL paths, missing objects are omitted, and duplicates are
removed. Results use canonical identity order by `objectTypeId` and `primaryId`:

```json
{
  "query": {
    "kind": "refs",
    "refs": [
      { "objectTypeId": "Customer", "primaryId": "github:customer:acme/co#42" },
      { "objectTypeId": "Invoice", "primaryId": "inv-1042" }
    ]
  },
  "includeTotal": false
}
```

`refs` accepts between 1 and 1,000 unique references and is intrinsically bounded. SQLite,
PostgreSQL, and the in-memory provider execute it natively, so it composes with traversal, sets,
filtering, projection, expansion, and pagination. Providers without native support use the storage
batch identity primitive for the bounded core fallback.


## Count, Exists, And Facets

`POST /api/objects/query/count` takes the same `query` body and returns `{ "count": number }`
without hydrating rows. `POST /api/objects/query/exists` returns `{ "exists": boolean }` and
stops after the first match — use it for cheap yes/no checks.

`POST /api/objects/query/facets` returns grouped counts. Add a `facets` array; each entry needs a
`propertyId` and a `limit`:

```json
{
  "query": { "kind": "start", "objectTypeId": "Invoice" },
  "facets": [{ "propertyId": "status", "limit": 10 }]
}
```

The response returns one result per requested property:

```json
{
  "facets": [
    {
      "propertyId": "status",
      "buckets": [
        { "value": "paid", "count": 128 },
        { "value": "overdue", "count": 14 }
      ]
    }
  ]
}
```

A faceted property must declare `query.searchable: true` and `query.facet: true` in the ontology
(`Invoice.status` does). See [search metadata](../ontology/search-metadata.md).


## Page Tokens

A `page` node returns an opaque `nextPageToken` when another page is available:

```json
{
  "query": {
    "kind": "page",
    "pageSize": 25,
    "input": {
      "kind": "sort",
      "fields": [{ "kind": "property", "propertyId": "dueDate", "direction": "asc" }],
      "input": { "kind": "start", "objectTypeId": "Invoice" }
    }
  }
}
```

Send that token back as `pageToken` to read the next page. Keep the inner nodes identical between
page requests — only `pageToken` changes:

```json
{
  "query": {
    "kind": "page",
    "pageSize": 25,
    "pageToken": "<nextPageToken>",
    "input": {
      "kind": "sort",
      "fields": [{ "kind": "property", "propertyId": "dueDate", "direction": "asc" }],
      "input": { "kind": "start", "objectTypeId": "Invoice" }
    }
  }
}
```


## Expanding Links

An `expand` node attaches linked objects to each returned object under `links` without changing
which objects the query returns. Each entry in `expansions` names one link — `linkId`, `direction`
(`outgoing` or `incoming`), an optional `sourceObjectTypeId` to pin the source of an incoming link,
an optional `limit` + `orderBy` to bound a `"many"` expansion to the top-N targets per parent, and
a nested `expand` for deeper hops.

```json
{
  "query": {
    "kind": "expand",
    "expansions": [
      {
        "linkId": "customer",
        "direction": "outgoing",
        "expand": [{ "linkId": "region", "direction": "outgoing" }]
      }
    ],
    "input": { "kind": "start", "objectTypeId": "Invoice" }
  }
}
```

Expanded objects appear on each row under `links`, keyed by link id. A `"one"` link resolves to a
single object (or `null`); a `"many"` link resolves to an array. Expanded children have the same
object shape — so nested `links` recurse — plus an optional `linkProperties` carrying the
relationship's edge fields:

```json
{
  "objects": [
    {
      "primaryId": "inv-1042",
      "objectTypeId": "Invoice",
      "properties": { "id": "inv-1042", "amount": 8200, "status": "overdue" },
      "createdAt": "2026-05-01T09:00:00.000Z",
      "updatedAt": "2026-06-10T12:30:00.000Z",
      "links": {
        "customer": {
          "primaryId": "cust-7",
          "objectTypeId": "Customer",
          "properties": { "id": "cust-7", "name": "Globex" },
          "createdAt": "2026-01-02T00:00:00.000Z",
          "updatedAt": "2026-01-02T00:00:00.000Z",
          "links": {
            "region": {
              "primaryId": "eu-west",
              "objectTypeId": "Region",
              "properties": { "id": "eu-west" },
              "createdAt": "2026-01-01T00:00:00.000Z",
              "updatedAt": "2026-01-01T00:00:00.000Z"
            }
          }
        }
      }
    }
  ],
  "hasMore": false,
  "plan": { "mode": "pushdown" }
}
```


## Node Reference

| Node | Fields | Purpose |
| --- | --- | --- |
| `start` | `objectTypeId`, `includeSubtypes?` | Begin with all objects of one type. |
| `refs` | `refs` | Begin with 1–1,000 exact, heterogeneous `{ objectTypeId, primaryId }` identities. |
| `filter` | `input`, `predicate` | Apply a property predicate tree. |
| `text` | `input`, `query`, `fields?` | Keyword search over `search.defaultText` or explicit `fields`. |
| `vector` | `input`, `vector`, `propertyId`, `k` | Nearest-neighbor search on a numeric-array property. |
| `traverse` | `input`, `linkId`, `direction`, `sourceObjectTypeId?` | Follow an `outgoing` or `incoming` link. |
| `expand` | `input`, `expansions` | Attach linked objects to each row under `links`, keeping the result type. See [Expanding Links](#expanding-links). |
| `set` | `op`, `inputs` | Combine object sets with `union`, `intersect`, or `subtract`. |
| `sort` | `input`, `fields` | Order by properties or provider relevance. |
| `limit` | `input`, `limit` | Bound the result count. |
| `page` | `input`, `pageSize`, `pageToken?` | Request a cursor page. |
| `project` | `input`, `properties?` | Return only the listed properties. |

Each `sort` field is `{ "kind": "property", "propertyId", "direction" }` or
`{ "kind": "relevance", "direction" }`; `relevance` requires a `text` node upstream and provider
support.

Raw queries can traverse wildcard links that the fluent builder cannot (the result type can't be
inferred). When several types declare a link with the same `linkId`, omit `sourceObjectTypeId` on
an incoming `traverse` to match the union of all of them, or set it to pin one source type.


## Predicate Shapes

Inside a `filter` node, `predicate` is a predicate tree.

| Predicate | Raw shape |
| --- | --- |
| `and` / `or` | `{ "op": "and", "items": [...] }` |
| `not` | `{ "op": "not", "item": ... }` |
| `eq` / `neq` / `lt` / `lte` / `gt` / `gte` | `{ "op": "gte", "propertyId": "amount", "value": 5000 }` |
| `in` | `{ "op": "in", "propertyId": "status", "values": ["sent", "overdue"] }` |
| `exists` | `{ "op": "exists", "propertyId": "dueDate", "value": true }` |
| `contains` | `{ "op": "contains", "propertyId": "number", "value": "2026" }` |

Set `value: false` on `exists` to match a missing property. Values are checked against the property
schema; ordered comparisons (`lt`/`gte`/sorting) require an orderable schema — string, number,
date, timestamp, uuid, or enum. See [querying](./querying.md) for null-versus-missing semantics.


## Calling A Route

```bash
curl -X POST http://localhost:3000/api/objects/query \
  -H "content-type: application/json" \
  -d '{
    "query": {
      "kind": "limit",
      "limit": 20,
      "input": {
        "kind": "filter",
        "predicate": { "op": "eq", "propertyId": "status", "value": "overdue" },
        "input": { "kind": "start", "objectTypeId": "Invoice" }
      }
    }
  }'
```

Authentication and CSRF handling follow your server configuration; see
[authentication](../auth/authentication.md).


## Provider Support

SQLite and PostgreSQL object storage cover the common graph workflow: exact reference sets,
property filters, text search, sorting, limits, cursor pages, link traversal, set operations, and
projection.

Exact `refs` sources are pushed down by the bundled providers and fall back to core's bounded batch
primitive on providers without native support.

Vector search and relevance sorting require explicit storage-provider support. When a provider
can't execute a requested feature, Sixb returns a structured planning error rather than a partial
or approximate result. For simple bounded filters and sorts, Sixb can sometimes evaluate the query
in the core runtime when a provider lacks native support — but treat text search, traversal, set
operations, vector search, and relevance sorting as provider-backed.


## Related

- [Querying](./querying.md) — the fluent builder these routes mirror
- [Typed queries](../client/typed-queries.md) — type-checked browser client
- [Search metadata](../ontology/search-metadata.md) — query metadata that makes properties queryable
