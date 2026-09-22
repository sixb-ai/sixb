# Syncs

A sync imports data from an external system into a [dataset](../datasets/overview.md) using a
[connector](../connectors/overview.md).

## Define a sync

Export a sync from `syncs/`. Choose a connector, read from its client, and return rows that match
the target dataset's schema. Use [pipelines](../pipelines/overview.md) for joins and transformations.

```ts
// syncs/invoices.ts
import { defineSync } from "@sixb/core"
import { erp } from "../connectors/erp"
import { invoices } from "../datasets/invoices"

export const importInvoices = defineSync("import-invoices")
  .from(erp)
  .read((client) => client.listInvoices())
  .intoDataset(invoices)
```

## Run automatically

Defining a sync does not start it. Attach a [schedule](../schedules/overview.md) with `.when(...)`
to run it on a timer or in response to an event:

```ts
import { hourlyInvoices } from "../schedules/invoices"

export const importInvoices = defineSync("import-invoices")
  .when(hourlyInvoices)
  .from(erp)
  .read((client) => client.listInvoices())
  .intoDataset(invoices)
```

## Choose a sync mode

Set `mode` in `defineSync("import-invoices", { mode: "append" })` to control how rows are written:

| Mode | Behavior |
| --- | --- |
| `"snapshot"` (default) | Replaces the dataset with the full set of returned rows. |
| `"append"` | Adds returned rows to the dataset. |
| `"merge"` | Inserts, updates, or deletes rows by primary key. |

For datasets with [`sequenceBy`](../datasets/source-ordering.md), snapshots keep the newest source
rows and retain records omitted from the response. Removal requires an explicit sequenced delete.

To read only changes since the previous run, use a checkpoint. See [Incremental syncs](incremental.md).

## Sync connected accounts

For [OAuth connectors](../connectors/authentication.md), Sixb reads each connected account
automatically. Use `connection.account.id` when rows need to identify their source account:

```ts
import { defineSync } from "@sixb/core"
import { social } from "../connectors/social"
import { videos } from "../datasets/videos"

export const importVideos = defineSync("import-videos")
  .from(social)
  .read(async (client, { connection }) => {
    const rows = await client.listVideos()
    return rows.map((video) => ({
      id: video.id,
      title: video.title,
      accountId: connection.account.id,
    }))
  })
  .intoDataset(videos)
```

If record IDs can repeat across accounts, include the account ID in the dataset's primary key.
Incremental checkpoints are saved separately for each connection and account.

## Import files

Use `blobs.put()` to store a file and include its returned reference in a `fileRef` column.
An async generator lets the sync return rows as files are fetched:

```ts
import { defineSync } from "@sixb/core"
import { erp } from "../connectors/erp"
import { documents } from "../datasets/documents"

export const importDocuments = defineSync("import-documents")
  .from(erp)
  .read(async function* (client, { blobs }) {
    for (const doc of await client.listDocuments()) {
      const fileRef = await blobs.put({
        body: await client.fetchDocumentBytes(doc.id),
        fileName: `${doc.title}.pdf`,
        mediaType: "application/pdf",
      })

      yield { id: doc.id, title: doc.title, fileRef }
    }
  })
  .intoDataset(documents)
```
