# @sixb/lake-local

Local filesystem `LakeStorage` provider for Sixb V1 datasets.

Use `@sixb/lake-local` when you want versioned datasets backed by plain files on disk. Blob payloads are handled by a separate `BlobStorage`, such as `@sixb/blob-local`.

## Install

```bash
bun add @sixb/lake-local
```

## Usage

```ts
import { createSixb } from "@sixb/core"
import { LocalBlobStorage } from "@sixb/blob-local"
import { LocalLakeStorage } from "@sixb/lake-local"

const blobStorage = new LocalBlobStorage({
  basePath: ".sixb",
})

const lakeStorage = new LocalLakeStorage({
  path: ".sixb/lake",
})

const sixb = await createSixb({
  id: "my-app",
  broker: myBroker,
  storage: myStorage,
  lakeStorage,
  blobStorage,
  queues: myQueues,
})
```

You can also use the provider directly:

```ts
import { change, col, defineDataset } from "@sixb/core"
import { LocalBlobStorage } from "@sixb/blob-local"
import { LocalLakeStorage } from "@sixb/lake-local"

const blobs = new LocalBlobStorage({ basePath: ".sixb" })
const lake = new LocalLakeStorage({ path: ".sixb/lake" })

const invoicesDataset = defineDataset("raw.accounting.invoices", {
  schema: [
    col("invoiceId", "string"),
    col("pdf", "fileRef", { nullable: true }),
  ],
  primaryKey: "invoiceId",
})

await lake.createDataset(invoicesDataset)

const pdf = await blobs.put({
  body: invoicePdfBytes,
  fileName: "invoice-1001.pdf",
  mediaType: "application/pdf",
  logicalPath: "invoices/2026/04/invoice-1001.pdf",
})

const write = await lake.beginWrite({
  dataset: invoicesDataset,
  mode: "append",
  producer: { kind: "sync", id: "sync-invoices" },
})

await write.writeRows([
  {
    invoiceId: "inv_1001",
    pdf,
  },
])

await write.commit()
```

### Keyed merges

For a dataset with a primary key, `beginMerge()` stages complete-row upserts and keyed deletes:

```ts
const merge = await lake.beginMerge({
  dataset: invoicesDataset,
  producer: { kind: "sync", id: "sync-invoice-changes" },
})

await merge.writeChanges([
  change.delete({ invoiceId: "inv_1001" }),
  change.upsert({ invoiceId: "inv_1002", pdf: null }),
])

const result = await merge.commit()
```

The session captures the latest version when it begins and rejects its commit if another write wins
first. The final change for a repeated key wins. Deletes of absent keys, identical upserts, and
other changes that leave the visible rows unchanged do not create a version. An initial no-op
returns `{ outcome: "unchanged", version: null }`.

These are provider-level APIs. User-facing sync `mode: "merge"` is delivered separately.

## What Gets Stored On Disk

Given `path: ".sixb/lake"` and a dataset id of `raw.erp.orders`, the provider creates a layout like this:

```text
.sixb/lake/
  datasets/
    raw.erp.orders/
      definition.json
      state.json
      versions/
        ver_<uuid>.json
        ver_<uuid>.json
      rows/
        ver_<uuid>.jsonl
        ver_<uuid>.jsonl
  .tmp/
    session-<uuid>/
      rows.jsonl
    session-<uuid>/
      changes.jsonl
      result.jsonl
```

### Dataset Metadata

- `definition.json` stores the registered `DatasetDefinition`
- `state.json` stores lightweight mutable state such as `latestVersionId`
- `versions/ver_<uuid>.json` stores immutable version metadata including schema, producer, inputs, row counts, and parent version

### Row Storage

- each committed dataset version gets one immutable `rows/ver_<uuid>.jsonl` file
- rows are stored as line-delimited JSON
- `snapshot` writes create a version containing exactly the rows written in that session
- `append` writes materialize a new JSONL file containing the parent version's visible rows plus the newly written rows
- `merge` writes materialize a new JSONL file containing the complete resulting keyed dataset

That last point is important: V1 keeps append semantics simple and explicit. The provider does not mutate old row files.

## Notes

- dataset ids and version ids are path-encoded before being used as file names
- this provider is intentionally simple and favors inspectable files over compaction or query acceleration
- keyed writes reject duplicate primary keys, and merge commits are serialized per dataset within
  one process; V1 still assumes one writer process per keyed dataset
- `partitionBy` is stored as dataset metadata today; it does not yet change the on-disk row layout
