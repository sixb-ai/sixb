# @sixb/blob-s3

S3-compatible `BlobStorage` provider for Sixb `fileRef` payloads.

This package uses Bun's native `S3Client`, so it does not need the AWS SDK or another object storage
dependency. It works with AWS S3 and S3-compatible services such as Cloudflare R2, MinIO, DigitalOcean
Spaces, Backblaze B2, and Google Cloud Storage's S3-compatible API.

## Install

```bash
bun add @sixb/blob-s3
```

## Usage

```ts
import { S3BlobStorage } from "@sixb/blob-s3"

const blobStorage = new S3BlobStorage({
  bucket: "company-lake",
  region: "us-east-1",
  basePath: "sixb",
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

For S3-compatible providers, pass an `endpoint`:

```ts
const blobStorage = new S3BlobStorage({
  bucket: "sixb",
  endpoint: "http://localhost:9000",
  accessKeyId: "minioadmin",
  secretAccessKey: "minioadmin",
  basePath: "sixb",
})
```

Bun can also read credentials from environment variables, so constructor credentials are optional
when the runtime environment is already configured.

## Object Layout

Given `basePath: "sixb"`, blobs are stored at:

```text
s3://<bucket>/
  sixb/
    blobs/
      sha256/
        <sha256 hex>
```

Blob ids are content-addressed as `blob_<sha256 hex>`, and identical bytes return the same `blobId`
and digest. Use `basePath: ""` to store under `blobs/sha256/<hex>` at the bucket root.

`put(...)` returns a `FileRef` that includes the blob id, digest, size, and caller-provided file
name, media type, or logical path. `stat(...)` returns size and digest information for an existing
blob, or `null` when the blob id is unknown. `open(...)` returns a `ReadableStream<Uint8Array>` for
the stored bytes and throws for unknown blob ids.
