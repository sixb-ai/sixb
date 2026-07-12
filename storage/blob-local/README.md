# @sixb/blob-local

Local filesystem `BlobStorage` provider for Sixb `fileRef` payloads.

Use `@sixb/blob-local` when you want durable content-addressed blobs backed by plain files on disk.

## Install

```bash
bun add @sixb/blob-local
```

## Usage

```ts
import { LocalBlobStorage } from "@sixb/blob-local"

const blobStorage = new LocalBlobStorage({
  basePath: ".sixb",
})

const fileRef = await blobStorage.put({
  body: invoicePdfStream,
  expectedSizeBytes: invoiceSize,
  signal,
  fileName: "invoice-1001.pdf",
  mediaType: "application/pdf",
  logicalPath: "invoices/2026/04/invoice-1001.pdf",
})

const info = await blobStorage.stat(fileRef.blobId)
const stream = await blobStorage.open(fileRef.blobId)
```

`put(...)` consumes `ReadableStream<Uint8Array>` bodies with backpressure, computes SHA-256 while
writing to a temporary file, validates `expectedSizeBytes` when supplied, then atomically promotes
the completed file into the content-addressed layout. Failed and canceled writes remove their
temporary file. Byte arrays and `Blob` bodies remain supported for small or already-materialized
payloads.

## What Gets Stored On Disk

Given `basePath: ".sixb"`, blobs are stored at:

```text
.sixb/
  blobs/
    sha256/
      <sha256 hex>
```

Blob ids are content-addressed as `blob_<sha256 hex>`, and identical bytes reuse the same object.

`put(...)` returns a `FileRef` that includes the blob id, digest, size, and caller-provided
file name, media type, or logical path. `stat(...)` returns size and digest information for an
existing blob, or `null` when the blob id is unknown. `open(...)` returns a
`ReadableStream<Uint8Array>` for the stored bytes and throws for unknown blob ids.
