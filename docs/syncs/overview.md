# Syncs

A sync reads a [connector](../connectors/overview.md) and writes rows into one [dataset](../datasets/overview.md).
Keep joins and substantial transformations in [pipelines](../pipelines/overview.md).

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

This reads invoices into the dataset every hour. `.when(...)` accepts a named [schedule](../schedules/overview.md); repeat it to accept several triggers.

## Builder steps

| Step | Meaning |
| --- | --- |
| `defineSync("sync-erp-invoices", { mode })` | Names the sync; `mode` is `"snapshot"` (default), `"append"`, or `"merge"` |
| `.when(schedule)` | Declares when the sync runs; callable multiple times (OR semantics) |
| `.checkpoint<T>()` | Opts into a typed incremental checkpoint (optional) |
| `.from(connector)` | Chooses the source connector |
| `.read((client, context) => ...)` | Fetches rows from the connector's client |
| `.intoDataset(dataset)` | Chooses the target dataset |

The read handler receives the `client` returned by the connector's `connect()` and a `context`.
Snapshot and append handlers return rows; merge handlers return `change.upsert(...)` and
`change.delete(...)` values. Each handler may return one value, an iterable, or an async iterable.

## OAuth connector fan-out

An OAuth connector may have several project connections. A Sync reads all currently connected
accounts by default; its definition needs no selector:

```ts
export const syncSocialVideos = defineSync("sync-social-videos")
  .from(socialConnector)
  .read(async (social, { connection }) => {
    const videos = await social.listVideos()
    return videos.map((video) => ({
      ...video,
      sourceConnectionId: connection.id,
      sourceAccountId: connection.account.id,
    }))
  })
  .intoDataset(socialVideosDataset)
```

Connections are read sequentially in stable order. If one source fails, the complete run fails and
the previous dataset and checkpoints remain unchanged. Incremental checkpoints are isolated per
connection and account; replacing an account starts that connection without the old cursor.

Changing a sync’s connector requires a new sync ID. Its checkpoint belongs to the original source
and cannot be reused with another connector.

For merge datasets, include connection or account identity in the primary key whenever provider
record ids are not globally unique. With no connected account, the handler is not called and the
run follows the normal empty-result semantics for its mode.

## Sync modes

The sync mode controls how each run writes to the target dataset.

| Mode | Behavior | Good for |
| --- | --- | --- |
| `"snapshot"` (default) | Replaces the dataset with the current full view | Current customers, open invoices, active projects |
| `"append"` | Adds new rows to the dataset | Audit logs, webhook deliveries, invoice events |
| `"merge"` | Upserts and deletes rows by primary key | Ordered source change logs |

For datasets with [`sequenceBy`](../datasets/source-ordering.md#source-ordering), snapshot syncs **reconcile instead of replace**:

- Newer source rows win, even if a webhook-style write commits during the fetch.
- Missing rows stay; removal requires an explicit sequenced delete.
- Known concurrency conflicts retry up to 3 total commit attempts using the same staged data.
- The sync run keeps mode `snapshot`; its dataset version has mode `merge`.

For cursors, upserts, and deletes, see [Incremental syncs](incremental.md).

## Read context

The read handler signature is `(client, context)`.

| Field | Meaning |
| --- | --- |
| `context.projectId` | The current project id |
| `context.syncId` | This sync's id |
| `context.signal` | `AbortSignal` for cooperative cancellation |
| `context.blobs` | Blob facade (`put`, `open`, `stat`) for file ingestion |
| `context.connection` | Connection, slot and account metadata for OAuth-backed Syncs |
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

Sixb validates each returned `fileRef` — existence, digest, and size — before committing.

## Keep syncs small

A sync can do light cleanup as it reads — flatten a response, drop obviously invalid records — but
it should not become your whole data pipeline. Leave joins, heavy reshaping, business calculations,
and turning raw rows into canonical rows to a [pipeline](../pipelines/overview.md).

## File location

Export definitions from `syncs/`. See [Project structure](../fundamentals/project-structure.md) for discovery rules.

## Notes

- Running a sync requires the `run:sync` [grant](../auth/authorization.md).

## Related

- [Connectors](../connectors/overview.md) — how Sixb talks to external systems
- [Datasets](../datasets/overview.md) — the target table shape
- [Pipelines](../pipelines/overview.md) — reshape raw synced rows
- [Projections](../projections/overview.md) — turn raw rows into objects
