# Syncs

A sync pulls data from an external system into a [dataset](./datasets.md). Reach for one when you
need to bring real-world data — ERP invoices, customer records, employee rosters — into Sixb on a
schedule.

A sync wires three things together: a [connector](./connectors.md) that knows how to talk to the
external system, a read handler that fetches rows, and one target dataset that defines the table
shape. It is usually the first step in your data flow, before [pipelines](./pipelines.md) reshape
raw rows and [projections](./projections.md) turn them into objects.

## Define a sync

A sync chains a trigger (`.when`), a source connector (`.from`), a read handler (`.read`), and a
target dataset (`.intoDataset`).

```ts
// syncs/erp.ts
import { defineSync } from "@sixb/core"
import { acmeErpConnector } from "../connectors/acme-erp"
import { erpInvoicesDataset } from "../datasets/erp"
import { hourlyErpSync } from "../schedules/erp"

export const syncErpInvoices = defineSync("sync-erp-invoices")
  .when(hourlyErpSync)
  .from(acmeErpConnector)
  .read((erp) => erp.listInvoices())
  .intoDataset(erpInvoicesDataset)
```

This runs every hour, calls `listInvoices()` on the connector's client, and writes the rows into
`erpInvoicesDataset`.

## Builder steps

| Step | Meaning |
| --- | --- |
| `defineSync("sync-erp-invoices", { mode })` | Names the sync; `mode` is `"snapshot"` (default) or `"append"` |
| `.when(schedule)` | Declares when the sync runs; callable multiple times (OR semantics) |
| `.checkpoint<T>()` | Opts into a typed incremental checkpoint (optional) |
| `.from(connector)` | Chooses the source connector |
| `.read((client, context) => ...)` | Fetches rows from the connector's client |
| `.intoDataset(dataset)` | Chooses the target dataset |

The read handler receives the `client` returned by the connector's `connect()` and a `context`. It
may return one row, an iterable, or an async iterable.

## Schedules

Every sync declares when it runs with `.when(...)`. Call it more than once to add schedules; they
use OR semantics.

A schedule can observe time or a typed event:

| Schedule | Fires when |
| --- | --- |
| `defineSchedule(...).cron(...)` | its cron expression elapses |
| `defineSchedule(...).on(events.sync(sync).succeeded())` | a named sync succeeds |
| `defineSchedule(...).on(events.pipeline(pipeline).succeeded())` | a pipeline succeeds |
| `defineSchedule(...).on(events.dataset(dataset).updated())` | a dataset commits a version |

Schedule a sync by attaching a reusable schedule:

```ts
// schedules/erp.ts
import { defineSchedule } from "@sixb/core"

export const hourlyErpSync = defineSchedule("hourly-erp-sync").cron("0 * * * *", {
  timezone: "Europe/Paris",
})
```

Chain one sync after another so each run requests the next — useful when later rows reference
earlier ones (invoices reference customers, customers reference employees):

```ts
import { defineSchedule, defineSync, events } from "@sixb/core"
import { acmeErpConnector } from "../connectors/acme-erp"
import { erpCustomersDataset } from "../datasets/erp"

export const employeesImported = defineSchedule("erp-employees-imported").on(
  events.sync(syncErpEmployees).succeeded()
)

export const syncErpCustomers = defineSync("sync-erp-customers")
  .when(employeesImported)
  .from(acmeErpConnector)
  .read((erp) => erp.listCustomers())
  .intoDataset(erpCustomersDataset)
```

## Snapshot vs. append

The sync mode controls how each run writes to the target dataset.

| Mode | Behavior | Good for |
| --- | --- | --- |
| `"snapshot"` (default) | Replaces the dataset with the current full view | Current customers, open invoices, active projects |
| `"append"` | Adds new rows to the dataset | Audit logs, webhook deliveries, invoice events |

Snapshot is the default — omit `mode` for it. Use append when the source is event-like:

```ts
export const syncErpInvoiceEvents = defineSync("sync-erp-invoice-events", { mode: "append" })
  .when(hourlyErpSync)
  .from(acmeErpConnector)
  .read((erp) => erp.listInvoiceEvents())
  .intoDataset(erpInvoiceEventsDataset)
```

## Incremental syncs with checkpoints

For append sources you usually want each run to read only what is new. Call `.checkpoint<T>()` to
opt into a typed checkpoint. The read context then exposes the last `checkpoint` value and a
`setCheckpoint(next)` method to record progress for the next run.

```ts
export const syncErpInvoiceEvents = defineSync("sync-erp-invoice-events", { mode: "append" })
  .when(hourlyErpSync)
  .checkpoint<{ lastId: number }>()
  .from(acmeErpConnector)
  .read(async function* (erp, context) {
    const since = context.checkpoint?.lastId ?? 0
    const rows = await erp.listInvoiceEvents({ sinceId: since })

    let lastId = since
    for (const row of rows) {
      lastId = row.id
      yield row
    }

    context.setCheckpoint({ lastId })
  })
  .intoDataset(erpInvoiceEventsDataset)
```

Without `.checkpoint<T>()`, `context.checkpoint` is `undefined` and there is no `setCheckpoint`.

An append run that returns no rows still succeeds and stores its next checkpoint. If the dataset has
never received a row, that run does not create a dataset version, so dataset-updated schedules do
not fire. This lets incremental readers advance an initial cursor without inventing placeholder
rows.

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

### Ingesting files

When a dataset has a `fileRef` column for blob-backed files, use `context.blobs` to store the bytes
and write the returned `fileRef` into the row — for example, pulling the bytes for each ERP document
into blob storage:

```ts
export const syncErpDocuments = defineSync("sync-erp-documents")
  .when(hourlyErpSync)
  .from(acmeErpConnector)
  .read(async function* (erp, context) {
    for (const doc of await erp.listDocuments()) {
      const fileRef = await context.blobs.put({
        body: await erp.fetchDocumentBytes(doc.id),
        fileName: `${doc.title}.pdf`,
        mediaType: "application/pdf",
      })

      yield { id: doc.id, title: doc.title, fileRef }
    }
  })
  .intoDataset(erpDocumentsDataset)
```

`put()` also accepts an optional `logicalPath` to record a human-readable path alongside the stored
bytes.

The sync worker validates each returned `fileRef` — existence, digest, and size — before committing.

## Keep syncs small

A sync can do light cleanup as it reads — flatten a response, drop obviously invalid records — but
it should not become your whole data pipeline. Leave joins, heavy reshaping, business calculations,
and turning raw rows into canonical rows to a [pipeline](./pipelines.md).

## Convention

Put sync definitions in `syncs/` and export them. `createSixb()` discovers them automatically.

```txt
your-project/
  connectors/
    acme-erp.ts
  datasets/
    erp.ts
  schedules/
    erp.ts
  syncs/
    erp.ts
  sixb.config.ts
```

You can also register syncs explicitly:

```ts
import { createSixb } from "@sixb/core"
import { erpInvoicesDataset } from "./datasets/erp"
import { syncErpInvoices } from "./syncs/erp"

export const sixb = await createSixb({
  datasets: [erpInvoicesDataset],
  syncs: [syncErpInvoices],
})
```

Name syncs after the action and source entity: `sync-erp-invoices`, `sync-erp-customers`,
`sync-erp-invoice-events`.

## Notes

- Sync definitions are inert until a worker runs them. `sixb dev` can co-host sync workers locally.
- Running a sync requires the `run:sync` [grant](../auth/authorization.md).

## Related

- [Connectors](./connectors.md) — how Sixb talks to external systems
- [Datasets](./datasets.md) — the target table shape
- [Pipelines](./pipelines.md) — reshape raw synced rows
- [Projections](./projections.md) — turn raw rows into objects
