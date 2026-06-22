# Sync

A sync moves data from an external system into a dataset.

It uses a [connector](./connector.md) to read from the outside world and writes the result into
one [dataset](./datasets.md). Syncs are usually the first step in bringing real data into
Sixb.

## Why it is useful

A sync gives data movement a clear shape:

- one source connector
- one read function
- one target dataset
- one write mode

That keeps external access, table shape, and data movement separate.

The connector knows how to talk to the external system. The dataset defines the table shape.
The sync connects the two.

## Define a sync

File: `syncs/orders.ts`

```ts
import { defineSync } from "@sixb/core"
import { erpDb } from "../connectors/erp-db"
import { rawOrdersDataset } from "../datasets/orders"

export const syncOrders = defineSync("sync-orders")
  .from(erpDb)
  .read((db) => db`select * from orders`)
  .intoDataset(rawOrdersDataset)
```

This reads rows from `erpDb` and writes them into `rawOrdersDataset`.

## What each part does

| Part | Meaning |
| --- | --- |
| `defineSync("sync-orders")` | Names the sync |
| `.from(erpDb)` | Chooses the source connector |
| `.read((db) => ...)` | Reads records from the source |
| `.intoDataset(rawOrdersDataset)` | Chooses the target dataset |

The read handler receives the connected client returned by the connector.

## Snapshot syncs

Snapshot is the default mode.

Use a snapshot sync when each run should replace the target dataset with the current full view
of the source.

```ts
export const syncOrders = defineSync("sync-orders")
  .from(erpDb)
  .read((db) => db`select * from orders`)
  .intoDataset(rawOrdersDataset)
```

Good snapshot sources:

- current orders
- active customers
- inventory levels
- devices currently known by an API

## Append syncs

Use append mode when each run should add new rows instead of replacing the dataset.

```ts
export const syncOrderEvents = defineSync("sync-order-events", { mode: "append" })
  .from(erpDb)
  .read((db) => db`select * from order_events`)
  .intoDataset(rawOrderEventsDataset)
```

Good append sources:

- audit logs
- webhook deliveries
- order events
- new files arriving over time

## Schedule a sync

Define a reusable schedule, then attach it with `.when(...)`.

```ts
import { defineSchedule, defineSync } from "@sixb/core"

export const hourly = defineSchedule("hourly").cron("0 * * * *")

export const syncOrders = defineSync("sync-orders")
  .when(hourly)
  .from(erpDb)
  .read((db) => db`select * from orders`)
  .intoDataset(rawOrdersDataset)
```

You can also trigger one sync after another:

```ts
import { defineSync, syncFinished } from "@sixb/core"

export const syncCustomers = defineSync("sync-customers")
  .when(syncFinished(syncDepartments.id))
  .from(erp)
  .read((client) => client.listCustomers())
  .intoDataset(customersDataset)
```

## Keep syncs small

A sync can do light cleanup when it reads data, but it should not become your whole data
pipeline.

Good work for a sync:

- call the external system
- return rows
- flatten a response
- drop obviously invalid records

Better left to a [pipeline](./pipeline.md):

- joins
- heavy reshaping
- business calculations
- turning raw rows into canonical rows

## Sync files and blobs

Datasets can include `fileRef` columns for blob-backed files. When a sync needs to ingest
file bytes, use the blob facade on the read context.

```ts
import { col, defineDataset, defineSync } from "@sixb/core"
import { fileSource } from "../connectors/file-source"

export const rawFiles = defineDataset("raw.files", {
  schema: [
    col("id", "string"),
    col("name", "string"),
    col("relativePath", "string"),
    col("fileRef", "fileRef", { nullable: true }),
  ],
})

export const syncFiles = defineSync("sync-files")
  .from(fileSource)
  .read(async function* (client, context) {
    for await (const file of client.walk("/documents")) {
      const fileRef = await context.blobs.put({
        body: await client.open(file.path),
        fileName: file.name,
        mediaType: file.mediaType,
        logicalPath: file.relativePath,
      })

      yield {
        id: file.id,
        name: file.name,
        relativePath: file.relativePath,
        fileRef,
      }
    }
  })
  .intoDataset(rawFiles)
```

The connector reads the external source; `context.blobs` stores bytes in Sixb and returns the
`fileRef` to write into the row. The sync worker validates returned `fileRef` values before
committing, including existence, digest, and size.

## Convention

Put sync definitions in `syncs/` and export them.

```txt
your-project/
  connectors/
    erp-db.ts
  datasets/
    orders.ts
    order-events.ts
  syncs/
    orders.ts
    order-events.ts
  schedules/
    hourly.ts
  sixb.config.ts
```

`createSixb()` discovers exported sync definitions from `syncs/` automatically.

You can also register syncs explicitly:

```ts
import { createSixb } from "@sixb/core"
import { rawOrdersDataset } from "./datasets/orders"
import { syncOrders } from "./syncs/orders"

export const sixb = createSixb({
  datasets: [rawOrdersDataset],
  syncs: [syncOrders],
})
```

## How to model syncs

Start with one sync per source shape.

1. Define the connector first.
2. Define the raw dataset shape.
3. Create a sync that reads from the connector and writes that dataset.
4. Use snapshot unless the source is event-like.
5. Move cleanup and reshaping into pipelines as the project grows.

Good sync names usually start with the action and source entity:

- `sync-orders`
- `sync-order-events`
- `sync-customers`
- `sync-device-inventory`

## Extra details

- `read(...)` receives `(client, context)`.
- `context` includes `projectId`, `syncId`, `signal`, and `blobs`.
- `read(...)` may return one row, an iterable, or an async iterable.
- sync definitions are inert until a worker runs them.
- `sixb dev` can co-host sync workers during local development.

The important first step is to keep each sync focused on moving one source shape into one
dataset.
