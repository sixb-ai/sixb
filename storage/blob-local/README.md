# @pario/blob-local

Local filesystem `BlobStorage` provider for Pario `fileRef` payloads.

Use `@pario/blob-local` when you want durable content-addressed blobs backed by plain files on disk.

## Install

```bash
bun add @pario/blob-local
```

## Usage

```ts
import { LocalBlobStorage } from "@pario/blob-local"

const blobStorage = new LocalBlobStorage({
  basePath: ".pario",
})

const fileRef = await blobStorage.put({
  body: invoicePdfBytes,
  fileName: "invoice-1001.pdf",
  mediaType: "application/pdf",
  logicalPath: "invoices/2026/04/invoice-1001.pdf",
})

const info = await blobStorage.stat(fileRef.blobId)
const stream = await blobStorage.open(fileRef.blobId)
```

## What Gets Stored On Disk

Given `basePath: ".pario"`, blobs are stored at:

```text
.pario/
  blobs/
    sha256/
      <sha256 hex>
```

Blob ids are content-addressed as `blob_<sha256 hex>`, and identical bytes reuse the same object.

`put(...)` returns a `FileRef` that includes the blob id, digest, size, and caller-provided
file name, media type, or logical path. `stat(...)` returns size and digest information for an
existing blob, or `null` when the blob id is unknown. `open(...)` returns a
`ReadableStream<Uint8Array>` for the stored bytes and throws for unknown blob ids.
