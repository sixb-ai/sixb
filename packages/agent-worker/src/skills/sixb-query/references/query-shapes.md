# Query Shapes

Query payloads use a nested `query` object. Start with an object set, then compose transforms.

## Start

```json
{ "kind": "start", "objectTypeId": "customer", "includeSubtypes": true }
```

## Filter

```json
{
  "kind": "filter",
  "input": { "kind": "start", "objectTypeId": "customer" },
  "predicate": { "kind": "eq", "propertyId": "status", "value": "active" }
}
```

## Sort And Limit

```json
{
  "kind": "limit",
  "input": {
    "kind": "sort",
    "input": { "kind": "start", "objectTypeId": "customer" },
    "by": [{ "propertyId": "createdAt", "direction": "desc" }]
  },
  "limit": 20
}
```

## Page

Use `page` instead of a top-level cursor when continuing through query results.

```json
{
  "kind": "page",
  "input": { "kind": "start", "objectTypeId": "customer" },
  "pageSize": 20,
  "pageToken": "next-page-token-from-previous-response"
}
```

## Traverse Links

Use link ids from the ontology.

```json
{
  "kind": "traverse",
  "input": { "kind": "start", "objectTypeId": "customer" },
  "linkId": "customerOrders",
  "direction": "out"
}
```

## Expand

Use expand when the answer needs related objects alongside the root objects.

```json
{
  "kind": "expand",
  "input": { "kind": "start", "objectTypeId": "customer" },
  "links": [{ "linkId": "customerOrders", "direction": "out", "limit": 5 }]
}
```
