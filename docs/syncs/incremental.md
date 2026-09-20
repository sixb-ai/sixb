# Incremental syncs

Read only new source data by saving a checkpoint after each successful run. Use append for event streams and merge for a current view of keyed records.

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

## Empty and unchanged runs

Successful runs save their next checkpoint even when no new dataset version is created.
Only a new version triggers dataset-update schedules.

| Result | Version behavior |
| --- | --- |
| Append with no rows | Keeps the existing version; does not initialize an empty dataset. |
| First successful snapshot with no rows | Creates an addressable empty version and emits its update event. |
| Empty snapshot, without `sequenceBy` | Replaces existing rows with an empty version; later identical empty snapshots reuse it. |
| Empty snapshot, with `sequenceBy` | Retains existing rows, including a concurrent writer's rows; reuses that version. |
| Merge with no effective changes | Reuses the version; an initial delete of an absent key without sequencing creates none. |
| A new deletion sequence | Creates a version even if the key was already absent. |

Pipelines and projections can consume the initialized empty snapshot. A replacing empty snapshot
withdraws the projection's source claims; it does not automatically delete ontology objects.

## Merge changes

Use merge when the source exposes ordered row changes and the dataset should remain a current view:

```ts
import { change, col, defineDataset, defineSync } from "@sixb/core"

const erpInvoicesDataset = defineDataset("erp.invoices", {
  schema: [
    col("invoiceId", "string"),
    col("status", "string"),
    col("customerId", "string"),
  ],
  primaryKey: "invoiceId",
})

export const syncErpInvoices = defineSync("sync-erp-invoices", { mode: "merge" })
  .checkpoint<{ cursor: string }>()
  .from(acmeErpConnector)
  .read(async function* (erp, context) {
    for await (const event of erp.changesSince(context.checkpoint?.cursor)) {
      yield event.deleted
        ? change.delete({ invoiceId: event.invoiceId })
        : change.upsert(event.invoice)

      context.setCheckpoint({ cursor: event.cursor })
    }
  })
  .intoDataset(erpInvoicesDataset)
```

For datasets without `sequenceBy`, each upsert is a complete row, not a patch. Deletes provide exactly the primary-key fields. The
final change for a repeated key wins, identical upserts and deletes of absent keys are no-ops, and
no dataset version is created when the visible rows do not change. V1 requires non-null string
keys, ordered changes, immutable keys, and one registered writer per keyed dataset. Object and link
projections evaluate the complete committed dataset; telemetry projections from merge-written
datasets are not supported yet.

### Merge source requirements

Without `sequenceBy`, use merge only when the source provides a durable, ordered change log. Each source event needs a
stable cursor, a complete row for an upsert or the exact key for a delete, and deterministic replay.
Set the next checkpoint after yielding each event as shown above. Sixb stores the latest checkpoint
only after the entire merge commits, so retrying a failed run safely replays its changes.

Changing a row's key is two changes: delete the old key, then upsert the complete row under the new
key. Do not model it as a partial update.

If the source no longer recognizes the saved cursor because its retained log has a gap, stop the
merge and rebuild from a trusted snapshot or backfill before resuming. Missing lake-side change
history does not require source recovery: current projections evaluate the complete committed
dataset version rather than depending on incremental row history.
