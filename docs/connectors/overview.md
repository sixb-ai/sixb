# Connectors

A connector lets your Sixb project interact with an external API, database, or service.
Explore the [connector library](library.md) for existing connectors, or define your own below.

## Define a connector

Use an adapter from the [connector library](library.md) to define and export a connector from
your project's `connectors/` folder.

File: `connectors/billing.ts`

```ts
import { defineConnector } from "@sixb/core"
import { rest } from "@sixb/connector-rest"

export const billing = defineConnector("billing", rest({
  baseUrl: "https://api.example.com",
  headers: () => ({ authorization: `Bearer ${process.env.BILLING_TOKEN}` }),
}))
```

Sixb creates the client on first use and reuses it.

## Custom connectors

If your system isn't in the library, define a custom adapter. Its `connect()` function returns
the client your code will use.

File: `connectors/billing.ts`

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

`createBillingClient` is your own client or SDK wrapper. Optionally provide `disconnect()` to
close the client and release resources.

## Use a connector

Import your connector and pass it to a [sync](../syncs/overview.md) with `.from()`, or access its
client directly in your backend code. This example uses the REST connector above and assumes
`/invoices` returns an array matching your invoices dataset:

```ts
import { defineSync } from "@sixb/core"
import { billing } from "../connectors/billing"
import { invoices } from "../datasets/invoices"

export const syncInvoices = defineSync("billing-invoices")
  .from(billing)
  .read(async (client) => {
    const response = await client.get("/invoices")
    return response.json()
  })
  .intoDataset(invoices)

// In a backend handler with access to sixb:
const client = await sixb.connector(billing)
const invoice = await client.get("/invoices/123")
```

## Next steps

- [Connector library](library.md): Explore the available adapters.
- [OAuth](authentication.md): Let users connect their accounts.
- [Webhooks](webhooks.md): Receive updates from external systems.
