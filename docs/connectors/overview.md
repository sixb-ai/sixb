# Connectors

A connector gives your project a reusable client for an API, database, or external service.
Start with the [connector library](library.md), or define your own adapter.

## Define a connector

File: `connectors/billing.ts`

```ts
import { defineConnector } from "@sixb/core"
import { rest } from "@sixb/connector-rest"

export const billing = defineConnector("billing", rest({
  baseUrl: "https://api.example.com",
  headers: () => ({ authorization: `Bearer ${process.env.BILLING_TOKEN}` }),
}))
```

Export it from `connectors/`. Sixb opens the connection on first use and reuses the client.
Keep credentials here; keep row mapping in [syncs](../syncs/overview.md).

## Custom clients

An adapter provides `type` and `connect()`. It may also provide `disconnect(client)` to release resources.

```ts
import { defineConnector } from "@sixb/core"
import { createBillingClient } from "../lib/billing"

export const billing = defineConnector("billing", {
  type: "billing",
  connect({ signal }) {
    return createBillingClient({ signal })
  },
  disconnect(client) {
    return client.close()
  },
})
```

`createBillingClient` is your application code. It returns the methods your handlers need.

| `connect` context | Purpose |
| --- | --- |
| `projectId` | Current project identifier. |
| `connectorId` | This connector's identifier. |
| `signal` | Cancels work when the connector disconnects. |

## Use the client

A sync receives the client through `.from(billing)`. In a workflow or another backend handler,
resolve it with `await sixb.connector(billing)`.

Always import the registered definition. Creating another definition with the same ID does not
refer to the registered connector.

## Next

- [Library](library.md) — packaged adapters and their options.
- [Authentication](authentication.md) — API keys, OAuth, and connecting accounts from your app.
- [Webhooks](webhooks.md) — receive deliveries and update source datasets.
- [Syncs](../syncs/overview.md) — read the client into a dataset.
