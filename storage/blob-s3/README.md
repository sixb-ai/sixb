# @sixb/blob-s3

S3-compatible `BlobStorage` provider for Sixb `fileRef` payloads.

It works with AWS S3 and S3-compatible services such as Cloudflare R2, SeaweedFS, DigitalOcean Spaces,
Backblaze B2, and Google Cloud Storage's S3-compatible API. One official AWS SDK client handles
writes, reads, metadata, server-side copies, cleanup, and direct-upload URL signing.

## Why not just use `Bun.S3Client`?

On Bun 1.3.14/Linux, the native S3 multipart writer can retain native allocations after completed
parts. Across many uploads, process RSS can therefore keep growing even while the JavaScript heap
stays stable. Stream backpressure limits in-flight data, but it does not control the lifetime of
those native allocations.

The provider uses replayable, fixed-size `Uint8Array` parts through the AWS SDK instead. This lets it
bound concurrency, retry individual requests, and abort incomplete multipart uploads without
relying on Bun's native writer. A single long-lived client also keeps credentials, endpoints,
connection reuse, retries, and error behavior consistent across every operation.

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
  putPartSizeBytes: 8 * 1024 * 1024,
  putConcurrency: 2,
  putRetries: 3,
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

`put(...)` streams bodies to a temporary S3 object while computing SHA-256, then promotes the
completed object into the content-addressed layout with a server-side copy. Bodies no larger than
one part use one bounded `PutObject`; larger bodies use multipart upload. `putPartSizeBytes` and
`putConcurrency` bound provider-owned part buffers per active write; their defaults are 8 MiB and 2.
Approximate upload-buffer memory is therefore `putPartSizeBytes * putConcurrency`, plus one source
chunk and HTTP client overhead. `putRetries` controls retries of replayable AWS requests and
defaults to 3; the same policy applies to reads and metadata requests.

Failed and canceled multipart writes cancel the source, wait for in-flight requests, abort the S3
multipart upload, and remove any completed staging object. Byte arrays and `Blob` bodies remain
supported for small or already-materialized payloads.

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

Bucket CORS must allow `PUT`, `x-amz-checksum-sha256`, and `content-type` for browser uploads.

`completeUpload` verifies a server-owned copy so the browser cannot change the file during
validation. If the backend omits SHA-256, Sixb calculates it by streaming that copy. Incorrect
checksums, sizes, or failed reads reject the upload.

Completion uses two server-side copies and, when needed, one full streaming read with bounded
memory. Allow `GetObject`, `PutObject`, and `DeleteObject`. Cleanup failures after saving do not
fail the upload; configure staging expiration below to remove leftovers.

### Staging cleanup

Direct uploads and streamed `put(...)` calls land under `<basePath>/uploads/<uploadId>/object`
before being promoted to the content-addressed `blobs/sha256/` prefix. A crashed or abandoned
upload can leave bytes under `uploads/`, so configure an S3 lifecycle rule to expire objects under
that prefix.

The API aborts the multipart upload of a direct-upload session that expires unfinished, but only
while it is running. Add an `AbortIncompleteMultipartUpload` rule to the same bucket, with
`DaysAfterInitiation` set to at least one day, so parts left while the API was down are released.

For S3-compatible providers, pass an `endpoint`. For example, with the local SeaweedFS test fixture:

```ts
const blobStorage = new S3BlobStorage({
  bucket: "sixb-test",
  endpoint: "http://127.0.0.1:49000",
  accessKeyId: "sixb",
  secretAccessKey: "sixb-secret",
  basePath: "sixb",
})
```

When constructor credentials are omitted, the AWS SDK credential provider chain is used. This
supports environment variables, shared configuration, container credentials, and instance or
workload roles.

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

## Tests

```bash
bun --filter @sixb/blob-s3 test:e2e
```

Requires Docker. The suite starts a digest-pinned SeaweedFS instance on `127.0.0.1:49000`,
creates its test bucket, and removes its containers and data afterward. No cloud credentials required.

### Verify your backend

Before release, an operator or trusted CI should run this with the target backend's `S3_*`
environment variables:

```bash
bun storage/blob-s3/scripts/verify-direct-upload.ts
```

Checks a 10 MiB upload and readback, rejects altered bytes, and cleans up its isolated
`sixb-upload-verification/` prefix. Validation or cleanup failures return a nonzero exit code.
