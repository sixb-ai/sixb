# Object queries

Use JSON queries to read objects from services outside TypeScript. TypeScript apps can use the
[typed query builder](../client/typed-queries.md) instead.

For authentication and the generated endpoint schemas, see [HTTP API](overview.md).
Your running API also serves its reference at `/docs`.

## Routes

Each route accepts a JSON body with a top-level `query`:

| Route | Additional body fields | Result fields |
| --- | --- | --- |
| `POST /api/objects/query` | `includeTotal?` | `objects`, `hasMore`, `nextPageToken?`, `total?` |
| `POST /api/objects/query/count` | None | `count` |
| `POST /api/objects/query/exists` | None | `exists` |
| `POST /api/objects/query/facets` | `facets` | `facets` |
| `POST /api/objects/query/links` | `direction?`, `linkId?`, `includeObjects?`, `pageSize?`, `pageToken?` | `objects`, `links`, `hasMore`, `nextPageToken?` |

Object queries include `total` by default. Set `includeTotal: false` to skip the count.
Responses also include a diagnostic `plan`, except for link queries. Invalid queries return
HTTP 400 with an `issues` array.

## Send a query

Nodes describe the query from the inside out. This body for `POST /api/objects/query` starts
with invoices, filters to overdue ones, and returns up to 20:

```json
{
  "query": {
    "kind": "limit",
    "limit": 20,
    "input": {
      "kind": "filter",
      "predicate": { "op": "eq", "propertyId": "status", "value": "overdue" },
      "input": { "kind": "start", "objectTypeId": "Invoice" }
    }
  },
  "includeTotal": false
}
```

Each returned object has `primaryId`, `objectTypeId`, `properties`, `createdAt`, and `updatedAt`.
Timestamps are ISO strings. Property filters, sorting, search, and facets require the corresponding
[property query metadata](../ontology/properties.md#enable-queries).

## Query nodes

Most nodes wrap another node through `input`. `start` and `refs` select the initial objects;
`set` combines queries through `inputs`.

| Node | Fields besides `kind` | Purpose |
| --- | --- | --- |
| `start` | `objectTypeId`, `includeSubtypes?` | Select objects of a type. |
| `refs` | `refs` | Select known `{ objectTypeId, primaryId }` identities. |
| `filter` | `input`, `predicate` | Filter properties. |
| `text` | `input`, `query`, `fields?` | Search default or explicit text fields. |
| `vector` | `input`, `vector`, `profile`, `k` | Search by meaning using a named profile. |
| `traverse` | `input`, `linkId`, `direction`, `sourceObjectTypeId?` | Follow a relationship. |
| `expand` | `input`, `expansions` | Include related objects. |
| `set` | `op`, `inputs` | Combine with `union`, `intersect`, or `subtract`. |
| `sort` | `input`, `fields` | Order results. |
| `limit` | `input`, `limit` | Cap the result count. |
| `page` | `input`, `pageSize`, `pageToken?` | Read a cursor page. |
| `project` | `input`, `properties?` | Select returned properties. |

Each sort field is `{ kind: "property", propertyId, direction }` or `{ kind: "relevance", direction }`.
Directions are `"asc"` or `"desc"`. Relevance sorting requires a text search; both relevance and
vector search require storage-provider support.

For a `vector` node, `profile` names an object's vector profile and `vector` contains search text,
not a numeric array. See [semantic search](../objects/querying.md#search-by-meaning) for setup
and supported query combinations.

### Predicates

Use these shapes inside a `filter` node:

| Predicate | Shape |
| --- | --- |
| All / any conditions | `{ "op": "and", "items": [...] }` or `{ "op": "or", "items": [...] }` |
| Negation | `{ "op": "not", "item": ... }` |
| Comparison | `{ "op": "gte", "propertyId": "amount", "value": 5000 }` |
| One of several values | `{ "op": "in", "propertyId": "status", "values": ["sent", "overdue"] }` |
| Present / missing | `{ "op": "exists", "propertyId": "dueDate", "value": true }` |
| Contains | `{ "op": "contains", "propertyId": "number", "value": "2026" }` |

Comparison operators are `eq`, `neq`, `lt`, `lte`, `gt`, and `gte`. Set `value: false` on `exists`
to match missing properties. See [filtering objects](../objects/querying.md#filter-objects)
for null and missing-value behavior.

## Paginate results

Wrap a query in a `page` node. If another page exists, the response includes `nextPageToken`.
Send it back as `pageToken`, keeping the rest of the query unchanged:

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
  },
  "includeTotal": false
}
```

## Select known objects

A `refs` node accepts 1 to 1,000 unique identities, including objects of different types.
Missing objects are omitted and duplicates are removed. Results are ordered by type and primary ID:

```json
{
  "query": {
    "kind": "refs",
    "refs": [
      { "objectTypeId": "Customer", "primaryId": "cust-001" },
      { "objectTypeId": "Invoice", "primaryId": "inv-001" }
    ]
  }
}
```

## Read relationships

A `traverse` node returns the related objects. Its `direction` is `"outgoing"` or `"incoming"`.
For incoming traversal, set `sourceObjectTypeId` to select one source type when several types use
the same link ID. Omitting it includes all matching source types.

An `expand` node keeps the original objects and attaches related objects under `.links`:

```json
{
  "query": {
    "kind": "expand",
    "expansions": [{ "linkId": "customer", "direction": "outgoing" }],
    "input": {
      "kind": "limit",
      "limit": 20,
      "input": { "kind": "start", "objectTypeId": "Invoice" }
    }
  }
}
```

Each `links.customer` contains one object or `null` for a `"one"` link, or an array for a `"many"`
link. Related objects may include `linkProperties`. Expansion entries also accept
`sourceObjectTypeId`, `limit`, `orderBy`, and nested `expand` entries. Use `limit` and `orderBy` to
bound a many-valued relationship per parent.

### Read link records

Send a bounded object query to `POST /api/objects/query/links` to read its relationship records:

```json
{
  "query": {
    "kind": "refs",
    "refs": [{ "objectTypeId": "Customer", "primaryId": "cust-001" }]
  },
  "direction": "both",
  "includeObjects": true,
  "pageSize": 100
}
```

`direction` defaults to `"both"`. Each link contains `source`, `linkId`, `target`, optional
`properties`, and timestamps. `includeObjects: true` also returns the selected objects and visible
endpoints of the current link page.

The selector can match at most 1,000 objects and cannot contain `project` or `expand`. An object
`page` node must be outermost. Link pages default to 100 records and allow at most 1,000.

For the next link page, pass `nextPageToken` as the top-level `pageToken`. Keep the selector,
direction, and link filter unchanged. The caller must be able to view every type in the selector;
links to endpoint types they cannot view are omitted.

## Group counts

For `POST /api/objects/query/facets`, include a `facets` array with a property and bucket limit:

```json
{
  "query": { "kind": "start", "objectTypeId": "Invoice" },
  "facets": [{ "propertyId": "status", "limit": 10 }]
}
```

Each result contains `propertyId` and `buckets` of `{ value, count }`. The property must declare
`query: { searchable: true, facet: true }`. Counts cover the whole matching set, regardless of
row limits or pagination. For vector queries, they cover the selected top `k` results.
