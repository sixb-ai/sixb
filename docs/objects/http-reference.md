# HTTP & Raw Queries

Object queries run over HTTP as a raw query IR: a tree of nested nodes that the same
fluent builder produces under the hood. Most application code should use the fluent API
(see [querying](./querying.md)); reach for raw JSON when calling the HTTP routes directly,
using a generated client, or constructing queries outside TypeScript.

The TypeScript browser builder in `@sixb/client/query` produces this exact IR and posts it
to these routes for you. See [typed queries](../client/typed-queries.md) for the
type-checked path.


## Routes

All routes accept a JSON body with a top-level `query` node and validate it against the
registered ontology.

| Route | Body | Returns |
| --- | --- | --- |
| `POST /api/objects/query` | `{ query }` | `{ objects, hasMore, total, nextPageToken? }` |
| `POST /api/objects/query/count` | `{ query }` | `{ count }` |
| `POST /api/objects/query/exists` | `{ query }` | `{ exists }` |
| `POST /api/objects/query/facets` | `{ query, facets }` | `{ facets }` |

Every route also returns a diagnostic `plan` object for debugging. Application code normally
ignores it and reads the result fields above. Validation and planning failures return a
structured `issues` array (the client surfaces these as `SixbQueryError`).


## Raw Query JSON

Raw query nodes are nested with an `input` field, innermost-first. This query starts with
`Project`, filters, sorts, limits, and projects the returned properties:

```json
{
  "query": {
    "kind": "project",
    "properties": ["id", "name", "status", "budget"],
    "input": {
      "kind": "limit",
      "limit": 20,
      "input": {
        "kind": "sort",
        "fields": [{ "kind": "property", "propertyId": "budget", "direction": "desc" }],
        "input": {
          "kind": "filter",
          "predicate": {
            "op": "and",
            "items": [
              { "op": "eq", "propertyId": "status", "value": "active" },
              { "op": "gte", "propertyId": "budget", "value": 50000 }
            ]
          },
          "input": { "kind": "start", "objectTypeId": "Project" }
        }
      }
    }
  }
}
```

The row route response includes matching objects and pagination metadata:

```json
{
  "objects": [],
  "hasMore": false,
  "total": 0
}
```


## Count, Exists, And Facets

Call `POST /api/objects/query/count` with the same `query` body when you only need the
matching-set size. It returns `{ "count": number }` and does not hydrate object rows.

Call `POST /api/objects/query/exists` for cheap yes/no checks. It returns
`{ "exists": boolean }` and stops after the first matching object.

Call `POST /api/objects/query/facets` for grouped counts. The body adds a `facets` array;
each entry needs a `propertyId` and a `limit`:

```json
{
  "query": {
    "kind": "start",
    "objectTypeId": "Project"
  },
  "facets": [
    { "propertyId": "status", "limit": 10 }
  ]
}
```

The response returns one facet result per requested property:

```json
{
  "facets": [
    {
      "propertyId": "status",
      "buckets": [
        { "value": "active", "count": 12 },
        { "value": "paused", "count": 3 }
      ]
    }
  ]
}
```

Facet properties must declare `query.searchable: true` and `query.facet: true` in the
ontology. See [properties](../ontology/properties.md) for query metadata.


## Page Tokens

Raw `page` queries return an opaque `nextPageToken` when another page is available:

```json
{
  "query": {
    "kind": "page",
    "pageSize": 25,
    "input": {
      "kind": "sort",
      "fields": [{ "kind": "property", "propertyId": "deadline", "direction": "asc" }],
      "input": { "kind": "start", "objectTypeId": "Project" }
    }
  }
}
```

Send that token back as `pageToken` to read the next page. Keep the inner nodes identical
between page requests:

```json
{
  "query": {
    "kind": "page",
    "pageSize": 25,
    "pageToken": "<nextPageToken>",
    "input": {
      "kind": "sort",
      "fields": [{ "kind": "property", "propertyId": "deadline", "direction": "asc" }],
      "input": { "kind": "start", "objectTypeId": "Project" }
    }
  }
}
```


## Raw Node Reference

| Node | Purpose |
| --- | --- |
| `start` | Begin with all objects of one type. Raw JSON can set `includeSubtypes: true`. |
| `filter` | Apply property predicates. |
| `text` | Keyword search over `search.defaultText` or explicit `fields`. |
| `vector` | Nearest-neighbor search on a numeric-array property when supported. |
| `traverse` | Follow an outgoing or incoming ontology link. Incoming traversal accepts `sourceObjectTypeId` to pin one source type. |
| `set` | Combine compatible object sets with `union`, `intersect`, or `subtract`. |
| `sort` | Order by properties or provider-supported relevance. |
| `limit` | Bound the result count. |
| `page` | Request a cursor page. |
| `project` | Return only selected properties in raw query responses. |

Wildcard links cannot be traversed through the fluent API because the result type cannot be
inferred, but raw queries can traverse them. Several object types may declare a link with
the same id; omitting `sourceObjectTypeId` on a `traverse` node keeps the union of every
source type that declares the link, while setting it pins one source type.


## Raw Predicate Shapes

Inside a `filter` node, the `predicate` field is a predicate tree.

| Predicate | Raw shape |
| --- | --- |
| `and` / `or` | `{ "op": "and", "items": [...] }` |
| `not` | `{ "op": "not", "item": ... }` |
| `eq` / `neq` / `lt` / `lte` / `gt` / `gte` | `{ "op": "eq", "propertyId": "status", "value": "active" }` |
| `in` | `{ "op": "in", "propertyId": "status", "values": ["active", "paused"] }` |
| `exists` | `{ "op": "exists", "propertyId": "deadline", "value": true }` |
| `contains` | `{ "op": "contains", "propertyId": "name", "value": "Acme" }` |

Set `value: false` on an `exists` predicate to match a missing property. Predicate values
are checked against the property schema; ordered comparisons and sorting require an
orderable schema such as a string, number, date, timestamp, uuid, or enum. See
[querying](./querying.md) for null-versus-missing semantics.


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
        "predicate": { "op": "eq", "propertyId": "status", "value": "active" },
        "input": { "kind": "start", "objectTypeId": "Project" }
      }
    }
  }'
```

Authentication and CSRF handling follow your server configuration; see
[authentication](../auth/authentication.md).


## Provider Support Notes

SQLite and PostgreSQL object storage support the common graph-query workflow: typed property
filters, text search, property sorting, limits, raw cursor pages, link traversal, set
operations, and raw projection.

Vector search and relevance sorting require storage-provider support. If a provider cannot
execute a requested feature, Sixb returns a structured planning error instead of silently
returning a partial or approximate result. For simple bounded filters and sorts, Sixb can
sometimes evaluate the query in the core runtime when the storage provider lacks native
query support; treat text search, traversal, set operations, vector search, and relevance
sorting as provider-backed features.
