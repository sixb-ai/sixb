# Sync

A sync reads data from an external system through a connector and writes it into one Pario dataset.

Use syncs for source data that should land in the lake first, then be cleaned up by pipelines or
projected into objects later.

## Basic shape

```ts
import { defineSync } from "@pario/core"
import { erpDb } from "../connectors/erpDb"
import { rawOrdersDataset } from "../datasets/orders"

export const syncOrders = defineSync("sync-orders")
  .from(erpDb)
  .read(({ query }) => query("select * from orders"))
  .intoDataset(rawOrdersDataset)
```

| Step | Purpose |
| --- | --- |
| `defineSync("sync-orders", options?)` | Names the sync and sets options such as `mode` |
| `.checkpoint<T>()` | Optional: types source cursor state for later runs |
| `.from(connector)` | Chooses the source connector |
| `.read((client, context) => rows)` | Reads source rows |
| `.intoDataset(dataset)` | Chooses the target dataset |

The rows returned by `read(...)` should match the target dataset schema.

## Modes

Syncs support two write modes.

### `snapshot`

Use `snapshot` when each run returns the full current source state.

```ts
export const syncOrders = defineSync("sync-orders", { mode: "snapshot" })
  .from(erpDb)
  .read(({ query }) => query("select * from orders"))
  .intoDataset(rawOrdersDataset)
```

Good for:

- current orders
- active devices
- files where each run lists the whole folder

`snapshot` is the default mode, so `{ mode: "snapshot" }` is optional.

### `append`

Use `append` when each run returns new rows to add to the dataset.

```ts
export const syncOrderEvents = defineSync("sync-order-events", { mode: "append" })
  .from(erpDb)
  .read(({ query }) => query("select * from order_events"))
  .intoDataset(rawOrderEventsDataset)
```

Good for:

- event logs
- audit trails
- changes feeds
- incrementally discovered files

Most append syncs should use a checkpoint so they know where to resume.

## Read context

The read handler receives the connector client and a context:

```ts
.read(async (client, context) => {
  context.projectId
  context.syncId
  context.signal

  return []
})
```

Use `context.signal` with APIs that support cancellation.

If the sync uses `.checkpoint<T>()`, the context also includes:

```ts
context.checkpoint // T | undefined
context.setCheckpoint(next) // next must be T
```

## Checkpoints

A checkpoint is the source cursor for the next successful run. It can be a page token, timestamp,
incrementing id, high-water mark, or any other small JSON-compatible value.

```ts
type OrderEventsCheckpoint = {
  cursor: string
}

export const syncOrderEvents = defineSync("sync-order-events", { mode: "append" })
  .checkpoint<OrderEventsCheckpoint>()
  .from(erpDb)
  .read(async ({ query }, context) => {
    const cursor = context.checkpoint?.cursor ?? "0"

    const rows = await query(`select * from order_events where cursor > ${cursor}`)

    const nextCursor = rows.at(-1)?.cursor
    if (nextCursor) {
      context.setCheckpoint({ cursor: String(nextCursor) })
    }

    return rows
  })
  .intoDataset(rawOrderEventsDataset)
```

Checkpoint rules to know:

- First run: `context.checkpoint` is `undefined`.
- Later runs: `context.checkpoint` is the last saved checkpoint for that sync.
- Call `context.setCheckpoint(next)` when you know where the next run should resume.
- If the run fails or is cancelled, the checkpoint is not advanced.
- Checkpoints must be JSON-compatible. Store strings for dates, not `Date` objects.
- Avoid overlapping runs for checkpointed syncs unless replaying rows is safe.

### Changes-feed pattern

For APIs with a changes feed, bookmark the source before the first full scan. This prevents missing
changes that happen while the baseline scan is running.

```ts
type FilesCheckpoint = { startPageToken: string }

export const syncFiles = defineSync("sync-files", { mode: "append" })
  .checkpoint<FilesCheckpoint>()
  .from(filesApi)
  .read(async (files, context) => {
    if (!context.checkpoint) {
      const startPageToken = await files.getStartPageToken()
      context.setCheckpoint({ startPageToken })
      return files.listAllFiles()
    }

    const rows = []
    let pageToken: string | undefined = context.checkpoint.startPageToken

    while (pageToken) {
      const page = await files.listChanges({ pageToken })
      rows.push(...page.changes)
      pageToken = page.nextPageToken

      if (page.newStartPageToken) {
        context.setCheckpoint({ startPageToken: page.newStartPageToken })
      }
    }

    return rows
  })
  .intoDataset(rawFilesDataset)
```

## Triggers

Attach triggers with `.when(...)`.

```ts
import { defineSchedule, defineSync } from "@pario/core"

export const hourly = defineSchedule("hourly-order-events").cron("0 * * * *")

export const syncOrderEvents = defineSync("sync-order-events", { mode: "append" })
  .when(hourly)
  .from(erpDb)
  .read(({ query }) => query("select * from order_events"))
  .intoDataset(rawOrderEventsDataset)
```

## Project layout

Export sync definitions from `syncs/` and keep connectors and datasets separate:

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
```

`createPario()` discovers exported syncs automatically. You can also register syncs explicitly:

```ts
createPario({
  datasets: [rawOrdersDataset],
  connectors: [erpDb],
  syncs: [syncOrders],
})
```

## Best practices

- Put auth, connection setup, and provider-specific clients in connectors.
- Keep sync read handlers focused on fetching and lightly shaping source rows.
- Use `snapshot` for full current-state reads.
- Use `append` plus `.checkpoint<T>()` for event streams, cursors, and changes feeds.
- Keep checkpoint values small, plain JSON, and source-focused.
- Make append rows replay-safe when possible; failed runs can be retried from the previous
  checkpoint.
- Land raw source data in datasets first, then use pipelines/projections for cleanup and modeling.
- Name syncs by source and entity, such as `sync-orders` or `sync-order-events`.
