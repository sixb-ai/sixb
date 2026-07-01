# Predicates

Use property ids from `/api/object-types`. Match value shapes to the property type.

```json
{ "kind": "eq", "propertyId": "status", "value": "active" }
{ "kind": "neq", "propertyId": "status", "value": "archived" }
{ "kind": "lt", "propertyId": "score", "value": 50 }
{ "kind": "lte", "propertyId": "score", "value": 50 }
{ "kind": "gt", "propertyId": "score", "value": 50 }
{ "kind": "gte", "propertyId": "score", "value": 50 }
{ "kind": "in", "propertyId": "status", "values": ["active", "trial"] }
{ "kind": "exists", "propertyId": "ownerId" }
{ "kind": "contains", "propertyId": "name", "value": "acme" }
```

Compose predicates with boolean operators:

```json
{
  "kind": "and",
  "predicates": [
    { "kind": "eq", "propertyId": "status", "value": "active" },
    { "kind": "gte", "propertyId": "score", "value": 80 }
  ]
}
```

```json
{
  "kind": "or",
  "predicates": [
    { "kind": "eq", "propertyId": "tier", "value": "enterprise" },
    { "kind": "eq", "propertyId": "tier", "value": "strategic" }
  ]
}
```

```json
{
  "kind": "not",
  "predicate": { "kind": "eq", "propertyId": "status", "value": "archived" }
}
```
