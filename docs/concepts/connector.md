# Connector

A connector is Sixb's reusable connection to an external system.

Most connectors should feel boring. Pick a connector package, give it config, and use the
connected client from syncs, functions, or app code.

## When to use a connector

Create a connector when your project needs to:

- read data from an external system
- call a third-party API
- reuse the same database or API client in multiple places
- keep credentials and connection setup out of syncs, functions, and app code

Do not use a connector to describe data shape. Use a [dataset](./datasets.md) for tables and
an [ontology](./ontology.md) for objects.

## Start with a connector package

For common systems, define the connector with a package.

File: `connectors/erp-db.ts`

```ts
import { defineConnector } from "@sixb/core"
import { sql } from "@sixb/connector-sql"

export const erpDb = defineConnector("erp-db", sql(process.env.DATABASE_URL!))
```

That is the whole connector. Sixb now has one named place to get an ERP database client.

## Use it from a sync

Syncs receive the connected client from `.from(...)`.

```ts
import { defineSync } from "@sixb/core"
import { erpDb } from "../connectors/erp-db"
import { rawOrdersDataset } from "../datasets/orders"

export const syncOrders = defineSync("sync-orders")
  .from(erpDb)
  .read((db) => db`select * from orders`)
  .intoDataset(rawOrdersDataset)
```

This keeps the sync focused on one job: read rows and write them into a dataset.

## Another package example

REST APIs work the same way.

File: `connectors/billing-api.ts`

```ts
import { defineConnector } from "@sixb/core"
import { rest } from "@sixb/connector-rest"

export const billingApi = defineConnector(
  "billing-api",
  rest({
    baseUrl: "https://api.example.com",
    headers: {
      authorization: `Bearer ${process.env.BILLING_API_TOKEN}`,
    },
  })
)
```

Use package connectors when they already match what you need.

## Custom connectors

When there is no package for your system, define the connection yourself.

```ts
import { defineConnector } from "@sixb/core"
import { createScannerClient } from "../lib/scanner"

export const warehouseScanner = defineConnector("warehouse-scanner", {
  type: "scanner",
  connect() {
    return createScannerClient()
  },
})
```

A custom connector can return any client shape. Keep that client small and tailored to the
calls your project actually makes.

Add `disconnect(...)` only when the client needs cleanup.

```ts
export const warehouseScanner = defineConnector("warehouse-scanner", {
  type: "scanner",
  connect() {
    return createScannerClient()
  },
  disconnect(client) {
    return client.close()
  },
})
```

## Use a connector directly

You can also resolve a connector from the Sixb runtime.

```ts
import { erpDb } from "../connectors/erp-db"
import { sixb } from "../sixb.config"

export async function loadOrders() {
  const runtime = await sixb
  const db = await runtime.connector(erpDb)

  return db`select * from orders`
}
```

The first call opens the connection. Later calls reuse the same client for that runtime.

## Convention

Put connector definitions in `connectors/` and export them.

```txt
your-project/
  connectors/
    erp-db.ts
    billing-api.ts
  datasets/
    orders.ts
  syncs/
    orders.ts
  sixb.config.ts
```

`createSixb()` discovers exported connector definitions from `connectors/` automatically.

You can also register connectors explicitly:

```ts
import { createSixb } from "@sixb/core"
import { erpDb } from "./connectors/erp-db"

export const sixb = createSixb({
  connectors: [erpDb],
})
```

## Core principles

- Start with a connector package.
- Keep one connector focused on one external system.
- Keep credentials and connection setup inside the connector.
- Keep data mapping in syncs, pipelines, or projections.
- Move to a custom connector when the external system needs special behavior.

## Where connectors fit

| Need | Use |
| --- | --- |
| Talk to an external system | Connector |
| Store rows from that system | Dataset |
| Move external data into Sixb | Sync |
| Transform rows into cleaner rows | Pipeline |
| Turn rows into objects for apps | Projection |
