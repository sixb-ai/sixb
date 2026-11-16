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

One run of a sync runs at a time: a new run waits for the one in progress, and triggers that arrive
meanwhile join it. A sync of an OAuth connector runs
[once per connected account](#sync-connected-accounts), still one run of the sync at a time.

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

A sync of an [OAuth connector](../connectors/authentication.md) runs once for each connected
account. Each run reads one account, keeps its own checkpoint, and commits its own rows, so one
account's failure never holds back another's. `connection` is the account the run reads:

```ts
import { change, defineSync } from "@sixb/core"
import { social } from "../connectors/social"
import { videos } from "../datasets/videos"

export const importVideos = defineSync("import-videos", { mode: "merge" })
  .from(social)
  .read(async (client, { connection }) => {
    const rows = await client.listVideos()
    return rows.map((video) =>
      change.upsert({ id: video.id, title: video.title, accountId: connection.account.id })
    )
  })
  .intoDataset(videos)
```

Use `"merge"` or `"append"`. A snapshot of one account would replace every other account's rows,
so `defineSync` rejects `"snapshot"` for an OAuth connector. If record IDs can repeat across
accounts, include the account ID in the dataset's primary key.

A schedule starts a run for every connected account. A schedule on
`events.connector(social).connected()` starts one for the account that just connected, so its first
read doesn't wait for the next run:

```ts
const socialConnected = defineSchedule("social-connected").on(events.connector(social).connected())

export const importVideos = defineSync("import-videos", { mode: "merge" })
  .when(hourly) // every account
  .when(socialConnected) // the account in the event
  .from(social)
  // ...
```

To run one account now, for example when a [webhook](../connectors/webhooks.md) says it changed,
pass its connection:

```ts
await sixb.syncs.request({ syncId: importVideos.id, connectionId: connection.id })
```

Without `connectionId`, a request runs every account you may run: the project's and your own, or
everyone's with `can.manage` on the connector. `request()` returns one entry in `runs` for each. A
request for an account whose run hasn't started yet joins that run.

[Personal connections](../connectors/authentication.md#let-people-connect-their-own-accounts) are
read too. `connection.owner` is `{ type: "user", id }` for one and `{ type: "project" }`
otherwise. To show each person only their own rows, write the owner's id on each row, map it to a
`ref.user()` property with [`userRef.fromId`](../projections/overview.md#point-to-members), and grant
`can.view(Type).where((row) => row.p.owner.eq(currentUser()))`. Grant a workflow's group
`can.view(Type)` without the condition when it needs to see everyone's.

When an account needs reconnecting, its run fails with `connector.authorization_required`. The
account keeps its checkpoint and rows, and its first run after reconnecting resumes from there. A
person's own account isn't reported to `onError`, since they're the one to reconnect it; a project
connection is.

A [suspended](../auth/members.md#when-someone-leaves) member's connections are never read. The
sync keeps the rows it already read from them, still owned by that member. To delete or reassign
those rows, start a workflow from `events.users().suspended()`.

## Import files

Use `blobs.put()` to store a file and include its returned reference in a `fileRef` column.
`mediaType` is optional; when you pass it, it must be a single media type such as `application/pdf`.
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
