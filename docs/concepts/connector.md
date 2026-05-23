# Connector

A connector gives Sixb access to an external system.

## What it does

- handles how Sixb connects: auth, config, transport, retries, lifecycle
- returns a connected client from `connect()`
- connects only when resolved with `sixb.connector(...)`
- can clean up with `disconnect()`

## Parts

| Piece | Role |
| --- | --- |
| adapter | Knows how to open and optionally close the connection |
| definition | `defineConnector("erpDb", adapter)` |
| runtime | Registers definitions, connects lazily, caches clients, runs cleanup |
| client | The connected value returned by `connect()` |

## Adapter shape

```ts
const adapter = {
  type: "sql",
  connect(context) {
    return createClient(context)
  },
  disconnect(client) {
    return client.close()
  },
}
```

`context` includes:

- `projectId`
- `connectorId`
- `signal`

`disconnect(client)` is optional.

## Define a connector

File: `connectors/erpDb.ts`

```ts
import { defineConnector } from "@sixb/core"

const adapter = {
  type: "sql",
  connect(context) {
    return {
      async query(sql: string) {
        console.log(`[${context.projectId}:${context.connectorId}] ${sql}`)
        return []
      },
    }
  },
}

export const erpDb = defineConnector("erpDb", adapter)
```

`defineConnector()` names the adapter so the runtime can register and resolve it.

## Common definition styles

### Use an adapter package

```ts
import { defineConnector } from "@sixb/core"
import { rest } from "@sixb/connector-rest"
import { sql } from "@sixb/connector-sql"

export const billingApi = defineConnector(
  "billingApi",
  rest({ baseUrl: "https://api.example.com" })
)

export const erpDb = defineConnector(
  "erpDb",
  sql(process.env.DATABASE_URL!)
)
```

### Define a custom adapter in the project

Use this when the connection needs project-specific auth, headers, client setup, or
protocol behavior.

```ts
import { defineConnector } from "@sixb/core"

export const billingApi = defineConnector("billingApi", {
  type: "rest",
  connect({ signal }) {
    return createBillingClient({ signal })
  },
})
```

## Convention

Export connector definitions from `connectors/`:

```txt
your-project/
  connectors/
    billingApi.ts
    erpDb.ts
  sixb.config.ts
```

`createSixb()` scans `connectors/` and registers exported connector definitions
automatically.

You can also register connectors explicitly with `createSixb({ connectors: [erpDb] })`.

## Resolve a connector

File: `lib/loadOrders.ts`

```ts
import { erpDb } from "../connectors/erpDb"
import { sixb } from "../sixb.config"

export async function loadOrders() {
  const runtime = await sixb
  const db = await runtime.connector(erpDb)
  return db.query("select * from orders")
}
```

The first call runs `connect(context)`. Later calls reuse the same client for that
runtime.

## Lifecycle

1. Define an adapter.
2. Wrap it with `defineConnector(id, adapter)`.
3. Register it explicitly or export it from `connectors/`.
4. Resolve it with `sixb.connector(definition)`.
5. Sixb caches the connected client.
6. `sixb.disconnectConnectors()` calls `disconnect(client)` if present.

## Guidelines

- Keep the connector focused on connection setup.
- Return a small client by default.
- Add a separate service layer only if it makes project code clearer.
