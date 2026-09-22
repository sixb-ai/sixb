# Incremental syncs

An incremental sync reads new or changed data since its last successful run. A checkpoint saves
where to resume.

## Save a checkpoint

Call `.checkpoint<T>()` to define the saved value. On the first run, `checkpoint` is `undefined`.
Pass it to the source API to resume reading, then call `setCheckpoint()` with the new position.

This connector returns pages of invoice events with a cursor for each page. The sync appends the
rows and records the cursor after each page:

```ts
// syncs/invoice-events.ts
import { defineSync } from "@sixb/core"
import { erp } from "../connectors/erp"
import { invoiceEvents } from "../datasets/invoice-events"

export const importInvoiceEvents = defineSync("import-invoice-events", { mode: "append" })
  .checkpoint<{ cursor: string }>()
  .from(erp)
  .read(async function* (client, { checkpoint, setCheckpoint }) {
    for await (const page of client.invoiceEventPages({ cursor: checkpoint?.cursor })) {
      yield* page.rows
      setCheckpoint({ cursor: page.cursor })
    }
  })
  .intoDataset(invoiceEvents)
```

Sixb saves the latest checkpoint after the run succeeds, including runs that return no new rows.
A failed run keeps the previous checkpoint. Use a new sync ID if you change its connector.

The mode controls how rows are written. The checkpoint controls where your code resumes reading;
Sixb does not filter the source data for you.

## Update and delete records

Use `mode: "merge"` to keep a current view of records. The dataset needs a primary key with non-null
string values. Each `change.upsert()` supplies a complete row; `change.delete()` supplies only the
primary-key fields.

```ts
// datasets/invoices.ts
import { col, defineDataset } from "@sixb/core"

export const invoices = defineDataset("erp.invoices", {
  schema: [
    col("invoiceId", "string"),
    col("status", "string"),
    col("customerId", "string"),
  ],
  primaryKey: "invoiceId",
})
```

Read changes in source order and record the cursor after yielding each change:

```ts
// syncs/invoices.ts
import { change, defineSync } from "@sixb/core"
import { erp } from "../connectors/erp"
import { invoices } from "../datasets/invoices"

export const importInvoices = defineSync("import-invoices", { mode: "merge" })
  .checkpoint<{ cursor: string }>()
  .from(erp)
  .read(async function* (client, { checkpoint, setCheckpoint }) {
    for await (const event of client.changesSince(checkpoint?.cursor)) {
      yield event.deleted
        ? change.delete({ invoiceId: event.invoiceId })
        : change.upsert(event.invoice)

      setCheckpoint({ cursor: event.cursor })
    }
  })
  .intoDataset(invoices)
```

A keyed dataset can have one registered sync or pipeline writer. Merge-written datasets support
object and relationship projections, but cannot feed [telemetry projections](../projections/telemetry.md).

## Source requirements

- Use a stable cursor and a source that can replay changes in order from that cursor.
- If changes can arrive out of order, use [`sequenceBy`](../datasets/source-ordering.md) to keep the
  newest source record.
- To change a primary key, delete the old key and insert the complete row under the new key.
- If a saved cursor expires, rebuild from a fresh snapshot or backfill before resuming. Skipping
  ahead can leave changes missing from the dataset.
