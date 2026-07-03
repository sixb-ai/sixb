# Examples

For `POST /api/objects/query`, keep pagination and limits inside the `query` shape.
Top-level request fields are limited to `query` and optional `includeTotal`.

## Active Customers

```bash
curl -sS -H "Content-Type: application/json" \
  -X POST "$SIXB_API_BASE_URL/api/objects/query" \
  --data '{
    "query": {
      "kind": "limit",
      "input": {
        "kind": "filter",
        "input": { "kind": "start", "objectTypeId": "customer" },
        "predicate": { "op": "eq", "propertyId": "status", "value": "active" }
      },
      "limit": 20
    },
    "includeTotal": true
  }'
```

## Recent Customers

```bash
curl -sS -H "Content-Type: application/json" \
  -X POST "$SIXB_API_BASE_URL/api/objects/query" \
  --data '{
    "query": {
      "kind": "limit",
      "input": {
        "kind": "sort",
        "input": { "kind": "start", "objectTypeId": "customer" },
        "fields": [{ "kind": "property", "propertyId": "createdAt", "direction": "desc" }]
      },
      "limit": 20
    }
  }'
```

## Active Customers Sorted By Creation Time

```bash
curl -sS -H "Content-Type: application/json" \
  -X POST "$SIXB_API_BASE_URL/api/objects/query" \
  --data '{
    "query": {
      "kind": "limit",
      "input": {
        "kind": "sort",
        "input": {
          "kind": "filter",
          "input": { "kind": "start", "objectTypeId": "customer" },
          "predicate": { "op": "eq", "propertyId": "status", "value": "active" }
        },
        "fields": [{ "kind": "property", "propertyId": "createdAt", "direction": "desc" }]
      },
      "limit": 20
    },
    "includeTotal": true
  }'
```

## Count Open Work Orders

```bash
curl -sS -H "Content-Type: application/json" \
  -X POST "$SIXB_API_BASE_URL/api/objects/query/count" \
  --data '{
    "query": {
      "kind": "filter",
      "input": { "kind": "start", "objectTypeId": "workOrder" },
      "predicate": { "op": "eq", "propertyId": "status", "value": "open" }
    }
  }'
```

## Facet By Status

```bash
curl -sS -H "Content-Type: application/json" \
  -X POST "$SIXB_API_BASE_URL/api/objects/query/facets" \
  --data '{
    "query": { "kind": "start", "objectTypeId": "workOrder" },
    "facets": [{ "propertyId": "status", "limit": 10 }]
  }'
```
