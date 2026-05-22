# Sync

A sync moves data from an external system, through a connector, into a Pario dataset.


## What a sync is

- uses one connector as the source
- reads data from the external system
- writes that data into one named Pario dataset
- can carry `mode` and optional `cron` metadata

## Sync types in Pario today

Pario currently supports batch syncs.

A batch sync reads a set of data from one connector and writes it into one dataset.

Batch syncs have two modes:

### Snapshot

Use `snapshot` when each run should replace the entire target dataset with the latest full
view of the source.

In other words, `snapshot` rewrites the dataset to match the current source state.

Examples:

- a table of orders
- a list of active devices from an API
- a folder of files treated as the current source of truth

### Append

Use `append` when each run should add new records onto the existing dataset instead of
replacing it.

In other words, `append` keeps the rows already in the dataset and writes new rows after them.

Examples:

- order events
- audit logs
- new files arriving over time

## What it looks like

File: `syncs/orders.ts`

```ts
import { defineSync } from "@pario/core"
import { erpDb } from "../connectors/erpDb"
import { rawOrdersDataset } from "../datasets/orders"

export const syncOrders = defineSync("sync-orders")
  .from(erpDb)
  .read(({ query }) => query("select * from orders"))
  .intoDataset(rawOrdersDataset)
```

Every sync has the same basic shape:

| Piece | Role |
| --- | --- |
| `defineSync("sync-orders", options?)` | Names the sync and optional metadata |
| `.from(erpDb)` | Chooses the source connector |
| `.read((client, context) => ...)` | Reads data from the external system |
| `.intoDataset(rawOrdersDataset)` | Chooses the target dataset definition |

Dataset definitions live in `datasets/` and declare schema once:

```ts
import { col, defineDataset } from "@pario/core"

export const rawOrdersDataset = defineDataset("raw.erp.orders", {
  schema: [
    col("orderId", "string"),
    col("customerId", "string", { nullable: true }),
  ],
  description: "Raw ERP orders",
})
```

## Read handler

The `read(...)` handler receives the connected client from the connector and a small context.

`context` includes:

- `projectId`
- `syncId`
- `signal`

`read(...)` may return one item, an iterable, or an async iterable.

You can also do small data transforms here if needed, such as renaming fields, flattening API
responses, or filtering out rows you do not want to land in the dataset.

`defineSync()` names the definition so the runtime can register and inspect it.

## Common examples

### Snapshot a table from a database

```ts
import { defineSync } from "@pario/core"
import { erpDb } from "../connectors/erpDb"
import { rawOrdersDataset } from "../datasets/orders"

export const syncOrders = defineSync("sync-orders")
  .from(erpDb)
  .read(({ query }) => query("select * from orders"))
  .intoDataset(rawOrdersDataset)
```

### Append new event rows

```ts
import { defineSync } from "@pario/core"
import { erpDb } from "../connectors/erpDb"
import { rawOrderEventsDataset } from "../datasets/orderEvents"

export const syncOrderEvents = defineSync("sync-order-events", {
  mode: "append",
  cron: "0 * * * *",
})
  .from(erpDb)
  .read(({ query }) => query("select * from order_events"))
  .intoDataset(rawOrderEventsDataset)
```

## Convention

Export sync definitions from `syncs/` and keep source connectors in `connectors/`:

```txt
your-project/
  connectors/
    erpDb.ts
  datasets/
    orders.ts
    orderEvents.ts
  syncs/
    orders.ts
    orderEvents.ts
  pario.config.ts
```

`createPario()` scans `syncs/` and registers exported sync definitions automatically.

You can also register syncs explicitly with `createPario({ datasets: [rawOrdersDataset], syncs: [syncOrders] })`.

Common naming conventions:

- name syncs by source and entity, such as `sync-orders` or `sync-order-events`
- name raw datasets by source and entity, such as `raw.erp.orders`
- keep one sync focused on one source shape and one target dataset

## How syncs fit

A connector handles access to the external system. A sync uses that connector to pull data into
a raw dataset. From there, other parts of your Pario project can read that dataset and shape it
into the rest of your app.

Pario registers syncs from `syncs/`, and you can inspect them with
`pario.getSyncDefinitions()` and `pario.getSyncById(id)`.

## Lifecycle

1. Choose a sync id and source connector.
2. Optionally add `mode` and `cron` metadata.
3. Read source rows with `.read((client, context) => ...)`.
4. Target a dataset with `.intoDataset(dataset)`.
5. Register it explicitly or export it from `syncs/`.
6. Let Pario discover and expose the definition.

## Guidelines

- Keep connection and auth concerns in the connector, not the sync.
- Keep the read handler focused on fetching source rows.
- Use `snapshot` for current-state reads and `append` for event-style feeds.
- Define datasets once in `datasets/` and reuse them from syncs and pipelines.
- Treat `cron` as metadata
