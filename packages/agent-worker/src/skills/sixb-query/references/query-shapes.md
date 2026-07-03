# Query Shapes

Query payloads use a nested `query` object. Start with an object set, then compose transforms.

Query nodes use `kind`. Filter predicates use `op` instead (see [predicates](predicates.md)).

## Start

```json
{ "kind": "start", "objectTypeId": "customer", "includeSubtypes": true }
```

## Filter

```json
{
  "kind": "filter",
  "input": { "kind": "start", "objectTypeId": "customer" },
  "predicate": { "op": "eq", "propertyId": "status", "value": "active" }
}
```

## Sort And Limit

Sort nodes use `fields`. Each field item must declare whether it is a property sort or relevance sort.

```json
{
  "kind": "limit",
  "input": {
    "kind": "sort",
    "input": { "kind": "start", "objectTypeId": "customer" },
    "fields": [{ "kind": "property", "propertyId": "createdAt", "direction": "desc" }]
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

Use link ids from the ontology. Direction is `outgoing` or `incoming`.

```json
{
  "kind": "traverse",
  "input": { "kind": "start", "objectTypeId": "customer" },
  "linkId": "customerOrders",
  "direction": "outgoing"
}
```

For incoming traversals, add `sourceObjectTypeId` when multiple object types may declare the same link id.

## Expand

Use expand when the answer needs related objects alongside the root objects. The query node uses `expansions`.

```json
{
  "kind": "expand",
  "input": { "kind": "start", "objectTypeId": "customer" },
  "expansions": [{ "linkId": "customerOrders", "direction": "outgoing", "limit": 5 }]
}
```
