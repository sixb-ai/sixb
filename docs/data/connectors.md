# Connectors

A connector is sixb's reusable connection to an external system. Pick a connector package,
give it config, and use the connected client from [syncs](./syncs.md) or app code.

Do not use a connector to describe data shape. Use a [dataset](./datasets.md) for tables and
an [ontology](../ontology/overview.md) for objects.

## When to use a connector

Create a connector when your project needs to:

- read data from an external system
- call a third-party API
- reuse the same database or API client in multiple places
- keep credentials and connection setup out of syncs, functions, and app code

## Start with a connector package

For common systems, define the connector with a package adapter.

File: `connectors/erp-db.ts`

```ts
import { defineConnector } from "@sixb/core"
import { sql } from "@sixb/connector-sql"

export const erpDb = defineConnector("erp-db", sql(process.env.DATABASE_URL!))
```

That is the whole connector. sixb now has one named place to get an ERP database client.

`defineConnector(id, adapter)` returns an inert `ConnectorDefinition`. It does not open a
connection — the runtime does that on first use.

## Built-in adapters

| Package | Factory | `type` | Connected client |
| --- | --- | --- | --- |
| `@sixb/connector-sql` | `sql(connection)` | `"sql"` | Bun `SQL` (Postgres, MySQL, SQLite) |
| `@sixb/connector-rest` | `rest(options)` | `"rest"` | `RestClient` (`request`/`get`/`post`) |
| `@sixb/connector-sftp` | `sftp(connection)` | `"sftp"` | `SftpClient` (`list`/`read`/`write`/...) |

### `sql(connection)`

Pass a connection string, a `URL`, or a Bun `SQL.Options` object. The connected client is the
native Bun SQL client, so all three databases share the same runtime shape. The adapter closes
the client on `disconnect`.

### `rest(options)`

```ts
import { rest } from "@sixb/connector-rest"

rest({
  baseUrl: "https://api.example.com",
  headers: { authorization: `Bearer ${process.env.TOKEN}` },
})
```

| Option | Type | Notes |
| --- | --- | --- |
| `baseUrl` | `string` | Required. Prepended to request paths. |
| `headers` | `HeadersInit` or `(ctx) => HeadersInit` | Static or per-request resolver (sync or async). |
| `timeoutMs` | `number` | Per-request timeout. |
| `minDelayMs` | `number` | Minimum delay between requests (rate limiting). |
| `onUnauthorized` | `(ctx) => void \| Promise<void>` | Hook to refresh credentials on a 401. |
| `retry` | `RestRetryPolicy` | `{ maxRetries, shouldRetry?, delayMs? }`. |

### `sftp(connection)`

Pass an ssh2 `ConnectConfig`. The connected `SftpClient` exposes `list`, `stat`, `exists`,
`ensureDir`, `read`, `write`, `rename`, `delete`, `mkdir`, and `rmdir`.

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

This keeps the sync focused on one job: read rows and write them into a dataset. See
[Syncs](./syncs.md).

## Use a connector directly

You can resolve a connector from the sixb runtime.

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

> **Footgun: pass the same registered instance.** `runtime.connector(...)` rejects a
> definition that is not the exact instance registered with the runtime. Even if the `id`
> matches, a freshly constructed `defineConnector(...)` with the same id throws
> `Connector '<id>' is not the registered definition instance.` Always import and pass the
> exported connector, not a local copy.

## Custom connectors

When no package fits, define the adapter yourself. An adapter needs a `type` and a `connect`,
and may add `disconnect` for cleanup.

```ts
import { defineConnector } from "@sixb/core"
import { createScannerClient } from "../lib/scanner"

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

A custom connector can return any client shape. Keep that client small and tailored to the
calls your project actually makes.

### ConnectorContext

`connect` receives a `ConnectorContext` so adapters can scope logs, build cache keys, or
cancel long-running startup work.

| Field | Type | Notes |
| --- | --- | --- |
| `projectId` | `string` | The runtime's project id. |
| `connectorId` | `string` | This connector's id. |
| `signal` | `AbortSignal` | Aborted when the runtime disconnects the connector. |

```ts
export const warehouseScanner = defineConnector("warehouse-scanner", {
  type: "scanner",
  connect(context) {
    return createScannerClient({ signal: context.signal })
  },
})
```

You can also compose a package adapter inside a custom one — call the inner adapter's
`connect(context)` and pass the same context through.

## Webhooks

A connector adapter may declare inbound `webhooks` alongside `connect`. Define them with
`defineWebhook(...)` and attach them on the adapter so the server can route incoming requests
to the connector's client.

```ts
import { defineConnector, defineWebhook } from "@sixb/core"

export const billingApi = defineConnector("billing-api", {
  type: "billing",
  webhooks: [
    defineWebhook("invoice-events")
      .post()
      .json()
      .handle(({ body }) => {
        console.log("[Billing] webhook", body)
      }),
  ],
  connect() {
    return createBillingClient()
  },
})
```

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

`createSixb()` discovers exported connector definitions from `connectors/` automatically. See
[Project structure](../fundamentals/project-structure.md). You can also register them explicitly:

```ts
import { createSixb } from "@sixb/core"
import { erpDb } from "./connectors/erp-db"

export const sixb = createSixb({
  connectors: [erpDb],
})
```

Connector ids must be unique within a runtime — a duplicate id throws at registration.

## Core principles

- Start with a connector package; move to a custom adapter only when the system needs special behavior.
- Keep one connector focused on one external system.
- Keep credentials and connection setup inside the connector.
- Keep data mapping in [syncs](./syncs.md), [pipelines](./pipelines.md), or [projections](./projections.md).

## Where connectors fit

| Need | Use |
| --- | --- |
| Talk to an external system | Connector |
| Store rows from that system | [Dataset](./datasets.md) |
| Move external data into sixb | [Sync](./syncs.md) |
| Transform rows into cleaner rows | [Pipeline](./pipelines.md) |
| Turn rows into objects for apps | [Projection](./projections.md) |
