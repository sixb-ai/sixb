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

## Staged Direct Uploads

`S3BlobStorage` also implements Sixb's optional direct-upload capability. The HTTP Files API uses
this to issue a short-lived signed `PUT` URL for browser uploads, then completes the staged object
back into the same content-addressed `FileRef` model.

```ts
const digest = await sha256File(file)
const upload = await blobStorage.createUpload({
  uploadId: "upload_123",
  fileName: "invoice.pdf",
  mediaType: "application/pdf",
  sizeBytes: file.size,
  expectedDigest: digest,
  expiresAt: new Date(Date.now() + 60_000),
})

if (upload.strategy === "direct-put") {
  await fetch(upload.url, {
    method: upload.method,
    headers: upload.headers,
    body: file,
  })

  const fileRef = await blobStorage.completeUpload({
    uploadId: upload.uploadId,
    stagingKey: upload.stagingKey,
    fileName: "invoice.pdf",
    mediaType: "application/pdf",
    expectedSizeBytes: file.size,
    expectedDigest: digest,
  })
}
```

The signed upload includes an `x-amz-checksum-sha256` header so the storage provider validates the
bytes uploaded by the browser. Bucket CORS must allow `PUT`, `x-amz-checksum-sha256`, and
`content-type` for browser direct uploads.

`completeUpload` fails closed on integrity: it issues a signed `HEAD` with
`x-amz-checksum-mode: ENABLED` and refuses to promote the staged object unless the backend reports
the same `x-amz-checksum-sha256` it verified on upload. Backends that do not store/return object
checksums cannot be used for direct uploads.

### Staging cleanup

Direct uploads land under `<basePath>/uploads/<uploadId>/object` before being promoted to the
content-addressed `blobs/sha256/` prefix. A crashed or abandoned upload can leave bytes under
`uploads/`, so configure an S3 lifecycle rule to expire objects under that prefix (there is no
in-repo sweeper).

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
