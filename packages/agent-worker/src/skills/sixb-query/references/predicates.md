# Predicates

Use property ids from `/api/object-types`. Match value shapes to the property type.

Predicates use `op`, not `kind` (unlike query nodes). Boolean groups use `items`, and `not` uses `item`.

```json
{ "op": "eq", "propertyId": "status", "value": "active" }
{ "op": "neq", "propertyId": "status", "value": "archived" }
{ "op": "lt", "propertyId": "score", "value": 50 }
{ "op": "lte", "propertyId": "score", "value": 50 }
{ "op": "gt", "propertyId": "score", "value": 50 }
{ "op": "gte", "propertyId": "score", "value": 50 }
{ "op": "in", "propertyId": "status", "values": ["active", "trial"] }
{ "op": "exists", "propertyId": "ownerId", "value": true }
{ "op": "contains", "propertyId": "name", "value": "acme" }
```

Compose predicates with boolean operators:

```json
{
  "op": "and",
  "items": [
    { "op": "eq", "propertyId": "status", "value": "active" },
    { "op": "gte", "propertyId": "score", "value": 80 }
  ]
}
```

```json
{
  "op": "or",
  "items": [
    { "op": "eq", "propertyId": "tier", "value": "enterprise" },
    { "op": "eq", "propertyId": "tier", "value": "strategic" }
  ]
}
```

```json
{
  "op": "not",
  "item": { "op": "eq", "propertyId": "status", "value": "archived" }
}
```

Set `value: false` on `exists` to match a missing property.
