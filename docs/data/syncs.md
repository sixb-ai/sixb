# Syncs

A sync moves data from an external system into a [dataset](./datasets.md).

It uses a [connector](./connectors.md) to read from the outside world and writes the result into
one dataset. Syncs are usually the first step in bringing real data into sixb.

A sync gives data movement a clear shape: one source connector, one read function, one target
dataset, and one write mode. That keeps external access, table shape, and data movement separate.
The connector knows how to talk to the external system, the dataset defines the table shape, and
the sync connects the two.

## Define a sync

A sync chains a trigger, a source connector, a read handler, and a target dataset. The
`.when(...)` trigger decides when the sync runs.

File: `syncs/orders.ts`

```ts
import { defineSync } from "@sixb/core"
import { hourly } from "../schedules/hourly"
import { erpDb } from "../connectors/erp-db"
import { rawOrdersDataset } from "../datasets/orders"

export const syncOrders = defineSync("sync-orders")
  .when(hourly)
  .from(erpDb)
  .read((db) => db`select * from orders`)
  .intoDataset(rawOrdersDataset)
```

This runs every hour, reads rows from `erpDb`, and writes them into `rawOrdersDataset`.

## Builder steps

| Step | Meaning |
| --- | --- |
| `defineSync("sync-orders")` | Names the sync (and optionally sets `{ mode }`) |
| `.when(trigger)` | Declares when the sync runs (schedule or run trigger) |
| `.checkpoint<T>()` | Opts into a typed incremental checkpoint (optional) |
| `.from(erpDb)` | Chooses the source connector |
| `.read((client, context) => ...)` | Reads records from the source |
| `.intoDataset(rawOrdersDataset)` | Chooses the target dataset |

The read handler receives the connected `client` returned by the connector and a `context`. It may
return one row, an iterable, or an async iterable.

## Triggers

Every sync declares when it runs with `.when(...)`. You can call `.when(...)` more than once;
multiple triggers use OR semantics, so any matching trigger requests a run independently.

A trigger is either a [schedule](../schedules/overview.md) or a run trigger built from a helper:

| Trigger | Fires when |
| --- | --- |
| a `defineSchedule(...)` value | the schedule's cron expression elapses |
| `syncFinished(syncId)` | a named sync run succeeds |
| `pipelineFinished(pipelineId)` | a named [pipeline](./pipelines.md) run succeeds |
| `datasetUpdated(datasetId)` | a [dataset](./datasets.md) receives a new committed version |

Schedule a sync by attaching a reusable schedule:

```ts
import { defineSchedule, defineSync } from "@sixb/core"

export const hourly = defineSchedule("hourly").cron("0 * * * *")

export const syncOrders = defineSync("sync-orders")
  .when(hourly)
  .from(erpDb)
  .read((db) => db`select * from orders`)
  .intoDataset(rawOrdersDataset)
```

Chain one sync after another so a run requests the next:

```ts
import { defineSync, syncFinished } from "@sixb/core"

export const syncCustomers = defineSync("sync-customers")
  .when(syncFinished(syncDepartments.id))
  .from(erp)
  .read((client) => client.listCustomers())
  .intoDataset(customersDataset)
```

## Snapshot syncs

Snapshot is the default mode. Use it when each run should replace the target dataset with the
current full view of the source.

```ts
export const syncOrders = defineSync("sync-orders")
  .when(hourly)
  .from(erpDb)
  .read((db) => db`select * from orders`)
  .intoDataset(rawOrdersDataset)
```

Good snapshot sources: current orders, active customers, inventory levels, devices currently known
by an API.

## Append syncs

Use append mode when each run should add new rows instead of replacing the dataset.

```ts
export const syncOrderEvents = defineSync("sync-order-events", { mode: "append" })
  .when(hourly)
  .from(erpDb)
  .read((db) => db`select * from order_events`)
  .intoDataset(rawOrderEventsDataset)
```

Good append sources: audit logs, webhook deliveries, order events, new files arriving over time.

## Incremental syncs with checkpoints

For append sources you often want each run to read only what is new. Call `.checkpoint<T>()` to opt
into a typed checkpoint. The read context then exposes the last `checkpoint` value and a
`setCheckpoint(next)` method to record progress for the next run.

```ts
export const syncOrderEvents = defineSync("sync-order-events", { mode: "append" })
  .when(hourly)
  .checkpoint<{ lastId: number }>()
  .from(erpDb)
  .read(async function* (db, context) {
    const since = context.checkpoint?.lastId ?? 0
    const rows = await db`select * from order_events where id > ${since} order by id`

    let lastId = since
    for (const row of rows) {
      lastId = row.id
      yield row
    }

    context.setCheckpoint({ lastId })
  })
  .intoDataset(rawOrderEventsDataset)
```

Without `.checkpoint<T>()`, `context.checkpoint` is `undefined` and there is no `setCheckpoint`.

## Read context

The read handler signature is `(client, context)`.

| Field | Meaning |
| --- | --- |
| `context.projectId` | The current project id |
| `context.syncId` | This sync's id |
| `context.signal` | `AbortSignal` for cooperative cancellation |
| `context.blobs` | Blob facade (`put`, `open`, `stat`) for file ingestion |
| `context.checkpoint` | Last checkpoint value (only with `.checkpoint<T>()`) |
| `context.setCheckpoint(next)` | Records the next checkpoint (only with `.checkpoint<T>()`) |

## Sync files and blobs

Datasets can include `fileRef` columns for blob-backed files. When a sync needs to ingest file
bytes, use the blob facade on the read context.

```ts
import { col, defineDataset, defineSync } from "@sixb/core"
import { hourly } from "../schedules/hourly"
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
  .when(hourly)
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

The connector reads the external source; `context.blobs` stores bytes in sixb and returns the
`fileRef` to write into the row. The sync worker validates returned `fileRef` values before
committing, including existence, digest, and size.

## Keep syncs small

A sync can do light cleanup when it reads data, but it should not become your whole data pipeline.

Good work for a sync: call the external system, return rows, flatten a response, drop obviously
invalid records.

Better left to a [pipeline](./pipelines.md): joins, heavy reshaping, business calculations, turning
raw rows into canonical rows.

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

`createSixb()` discovers exported sync definitions from `syncs/` automatically. You can also
register syncs explicitly:

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

1. Define the [connector](./connectors.md) first.
2. Define the raw [dataset](./datasets.md) shape.
3. Create a sync that reads from the connector and writes that dataset.
4. Use snapshot unless the source is event-like.
5. Move cleanup and reshaping into [pipelines](./pipelines.md) as the project grows.

Good sync names start with the action and source entity: `sync-orders`, `sync-order-events`,
`sync-customers`, `sync-device-inventory`.

## Notes

- Sync definitions are inert until a worker runs them.
- `sixb dev` can co-host sync workers during local development.
- See [datasets](./datasets.md), [connectors](./connectors.md), and [pipelines](./pipelines.md)
  for the rest of the data flow.
