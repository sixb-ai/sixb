# Actions API

All requests go through `$SIXB_API_BASE_URL`. Do not add Authorization or Cookie headers.

## List Actions

```bash
curl -sS "$SIXB_API_BASE_URL/api/actions"
```

## Request An Action

Before calling this route, show the user a concise preview of what will happen and ask for approval.
Do not request the action until the user approves.

```bash
curl -sS \
  -H "Content-Type: application/json" \
  -X POST "$SIXB_API_BASE_URL/api/actions/actionId" \
  --data '{
    "subject": {
      "kind": "object",
      "objectTypeId": "customer",
      "primaryId": "cust-001"
    },
    "params": {}
  }'
```

Use the subject and params shape required by the action definition. If no matching action exists,
explain that the requested change is not available through the ontology action surface.

For params whose schema is `{ "type": "objectRef", "objectTypeId": "customer" }`, pass the
value as `{ "objectTypeId": "customer", "primaryId": "cust-001" }` without a `kind`
field. This differs from the action `subject` shape, which uses `kind` to identify the
subject type.

## Get Action Run Detail

```bash
curl -sS "$SIXB_API_BASE_URL/api/action-runs/action_run_id"
```

Use the run id returned by an action request. The detail response includes status, phase, params,
writeback, commit diff, effects, and error details when available.
