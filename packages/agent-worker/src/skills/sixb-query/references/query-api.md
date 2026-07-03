# Query API

All requests go through `$SIXB_API_BASE_URL`. Do not add Authorization or Cookie headers.

## Discover Ontology

```bash
curl -sS "$SIXB_API_BASE_URL/api/object-types"
```

Use the returned ids exactly. Object type definitions describe properties, telemetry properties,
links, and applicable actions that are visible to the agent.

## List Objects

This is the only list-by-type route. Put the object type id in the `objectTypeId` query param
using the exact casing from the ontology. Do not use `/api/objects/{objectTypeId}` to list
objects; that path is not an API route.

```bash
curl -sS "$SIXB_API_BASE_URL/api/objects?objectTypeId=customer&limit=20"
```

Common query params: `objectTypeId`, `limit`, `offset`, `orderBy`, `order`, `idPrefix`, `idSuffix`, `createdAfter`, `createdBefore`, `updatedAfter`, `updatedBefore`.

## Get One Object

```bash
curl -sS "$SIXB_API_BASE_URL/api/objects/customer/cust-001"
```

The path form is only for reading one object by id: `/api/objects/{objectTypeId}/{primaryId}`.
It is not the collection route for a type.

## Object Query

POST query bodies only accept `query` and optional `includeTotal` at the top level. Result
bounds go inside the nested query shape: use a `limit` node for a fixed cap, or a `page`
node with `pageSize` and optional `pageToken` for pagination. Do not send top-level
`limit`, `cursor`, `pageSize`, or `pageToken` fields to this endpoint.

```bash
curl -sS \
  -H "Content-Type: application/json" \
  -X POST "$SIXB_API_BASE_URL/api/objects/query" \
  --data '{"query":{"kind":"limit","input":{"kind":"start","objectTypeId":"customer"},"limit":20},"includeTotal":true}'
```

## Count, Exists, Facets

```bash
curl -sS -H "Content-Type: application/json" \
  -X POST "$SIXB_API_BASE_URL/api/objects/query/count" \
  --data '{"query":{"kind":"start","objectTypeId":"customer"}}'

curl -sS -H "Content-Type: application/json" \
  -X POST "$SIXB_API_BASE_URL/api/objects/query/exists" \
  --data '{"query":{"kind":"start","objectTypeId":"customer"}}'

curl -sS -H "Content-Type: application/json" \
  -X POST "$SIXB_API_BASE_URL/api/objects/query/facets" \
  --data '{"query":{"kind":"start","objectTypeId":"customer"},"facets":[{"propertyId":"status","limit":10}]}'
```

## Common Mistakes

```bash
# This does not list customers; the gateway blocks it because it is not a documented route.
curl -sS "$SIXB_API_BASE_URL/api/objects/customer"

# Use the list route instead.
curl -sS "$SIXB_API_BASE_URL/api/objects?objectTypeId=customer&limit=20"
```
