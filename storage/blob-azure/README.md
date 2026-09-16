# @sixb/blob-azure

Azure Blob Storage provider for Sixb `fileRef` payloads. Implements `BlobStorage`
and `RangeReadableBlobStorage`, plus verified direct browser uploads, using the
official Azure SDK.

## Install

```bash
bun add @sixb/blob-azure
```

## Usage

```ts
import { AzureBlobStorage } from "@sixb/blob-azure"

const blobStorage = new AzureBlobStorage({
  accountName: process.env.AZURE_STORAGE_ACCOUNT_NAME!,
  container: "sixb-files",
  basePath: "sixb",
})

const fileRef = await blobStorage.put({
  body: invoiceStream,
  expectedSizeBytes: invoiceSize,
  signal,
  fileName: "invoice.pdf",
  mediaType: "application/pdf",
})

const info = await blobStorage.stat(fileRef.blobId)
const bytes = await blobStorage.open(fileRef.blobId)
const firstKilobyte = await blobStorage.openRange(fileRef.blobId, {
  start: 0,
  endInclusive: 1023,
})
```

Create the container before using the provider. For range reads, callers validate
the inclusive bounds against the blob size; the Sixb Files API does this already.

### Authentication

`accountName` constructs the standard `https://<account>.blob.core.windows.net`
service URL. Alternatively, supply an explicit HTTPS `serviceUrl`.

Both use `DefaultAzureCredential` by default, supporting local Azure development
credentials and deployed managed/workload identities. Give the identity
**Storage Blob Data Contributor** on the container. Server-side publication uses
the identity's storage token to read private staging; it does not request a user
delegation key.

To select a particular identity, pass a `credential` from `@azure/identity`:

```ts
import { ManagedIdentityCredential } from "@azure/identity"

const blobStorage = new AzureBlobStorage({
  accountName: process.env.AZURE_STORAGE_ACCOUNT_NAME!,
  container: "sixb-files",
  credential: new ManagedIdentityCredential({
    clientId: process.env.AZURE_CLIENT_ID!,
  }),
})
```

For shared-key authentication or Azurite, use a connection string instead:

```ts
const blobStorage = new AzureBlobStorage({
  container: "sixb-files",
  connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING!,
})
```

`connectionString` cannot be combined with `accountName`, `serviceUrl`, or
`credential`. It must contain an account key; SAS-only connection strings cannot
sign the private copy-source URLs needed for publication. Azurite's
`UseDevelopmentStorage=true` shorthand is supported.

## Content identity and publication

Objects use this layout inside the configured container:

```text
sixb/
  blobs/sha256/<sha256 hex>
  uploads/<random upload id>/object
  uploads/<direct upload id>/session.json
```

Set `basePath: ""` to place `blobs/` and `uploads/` at the container root.

`put` accepts Web byte streams, `Blob`, `Uint8Array`, and `ArrayBuffer`. It hashes
the source once with SHA-256, counts bytes, and stages replayable blocks with
Azure-verified transactional MD5. Size mismatches and canceled/failed uploads do
not publish partial content.

After committing private staging, the provider copies its bytes server-side into
uncommitted destination blocks, then publishes them with an atomic, create-only
block-list commit. This works for small and large files alike. Concurrent identical
writes deduplicate without overwriting an existing final blob. Azure ETags are
concurrency tokens, not content hashes.

Returned IDs are `blob_<sha256 hex>` and digests are `sha256:<hex>`. File name,
media type, and logical path are preserved on each returned reference. Stored
objects use a neutral content type; the Files API serves reference-specific headers.

Final keys belong to this provider: applications must not overwrite them outside
the provider. `stat` derives the digest from the key and reads size from Azure;
it does not download and rehash every read. Missing blobs return `null` from
`stat` and throw `BlobStorageError` from `open`/`openRange`. Missing containers,
authorization failures, and service errors propagate.

## Bounds and cleanup

| Option | Default | Bounds |
| --- | --- | --- |
| `blockSizeBytes` | 8 MiB | 1 byte–100 MiB |
| `concurrency` | 2 | 1–64 active upload blocks |
| `retries` | 3 | 0–20 retries per request |
| `directUploadMaxSizeBytes` | 512 MiB | At most `blockSizeBytes × 50,000` |
| `multipartThresholdBytes` | 32 MiB | Use multipart above this size; 1 byte–5,000 MiB |
| `completionConcurrency` | 2 | 1–64 active direct-upload completions per instance |
| `completionTimeoutMillis` | 5 minutes | 1 ms–1 hour for verification and publication |

Upload buffering is bounded by approximately `(concurrency + 1) * blockSizeBytes`,
plus the current source chunk and source/SDK buffers. Blocks are replayable, so SDK
retries do not consume the source again or change the SHA-256 calculation.

Azure allows 50,000 committed blocks. The maximum upload is therefore
`50_000 * blockSizeBytes` (about 390.6 GiB with the default). Known oversized inputs
are rejected before consumption; unknown-length streams are rejected at the block
limit. Increase block size for larger inputs. The SDK retry policy uses a 30-second
per-attempt timeout. Pass `signal` to bound the whole write, including source reads.

Staging cleanup runs after in-flight uploads settle, including on cancellation.
Cleanup failure is reported through a prefixed console warning and does not mask
the original result. Configure an Azure lifecycle deletion rule for the
`<container>/<basePath>/uploads/` prefix to reclaim staging after crashes or failed
cleanup. Keep final content in an online tier for immediate reads.

Failed publication can leave **uncommitted** destination blocks. They cannot be
read as a blob. Azure garbage-collects abandoned uncommitted blocks after a week
without further successful block/commit activity. The provider does not delete
the destination on failure because another writer may have published it.

## Browser uploads

The provider implements `DirectUploadBlobStorage` with single-PUT and multipart SAS uploads.
Sixb's existing client selects this path for files above the 25 MiB simple-upload
threshold; there is no Azure-specific client configuration:

```ts
import { uploadFile } from "@sixb/client"

const fileRef = await uploadFile(file, { client })
```

For direct provider integration, call `createUpload` with a unique `uploadId`,
SHA-256 `expectedDigest`, `sizeBytes`, and `expiresAt` in the next hour, then branch
on the returned session's `strategy`:

- **`direct-put`:** PUT the complete file to the session's URL using its headers.
- **`multipart`:** split the file into `partSizeBytes` chunks. Call `signUploadPart`
  with the session identity, expiry, and a one-based part number for each chunk,
  then PUT it to the signed URL using its headers. Collect successful part numbers
  in order; Azure does not require part ETags.

Call `completeUpload` with the upload ID, staging key, expected digest and size,
and reference metadata. For multipart, also pass the session's `providerUploadId`
and ordered `parts: [{ partNumber: 1 }, ...]`. `abortUpload` cancels the session.

The default browser upload maximum is 512 MiB. Increase `directUploadMaxSizeBytes`
up to `blockSizeBytes × 50,000`. Above `multipartThresholdBytes` (32 MiB by
default), the provider selects Azure block uploads automatically. The threshold
cannot exceed Azure's 5,000 MiB single-PUT limit.
This is a checked completion limit, not a SAS-enforced transfer quota: Azure may
accept a larger object, but the provider will refuse to complete it.

### Native multipart uploads

Multipart sessions return `partSizeBytes` equal to `blockSizeBytes` (8 MiB by
default). The standard client signs and uploads each part sequentially with Azure
`Put Block`. Sessions declare `partReceipt: "none"`, so the client submits only
successful part numbers. Block IDs are derived internally by the Azure provider.
Other providers can declare `partReceipt: "etag"` (also the default when omitted);
the client then requires an ETag after each part upload and fails immediately if
it is missing. Providers must also validate required ETags during completion.

Completion requires every receipt exactly once in ascending part-number order,
checks stored block sizes, and commits the ordered block list to staging. It then
uses the same full-file SHA-256 verification and safe publication as single-PUT.
Retries reuse already-committed staging rather than recommitting it. Session state
and part size are persisted so signing and completion work across provider instances.

Direct API users can re-sign/re-upload a block before completion; the standard
client does not automatically retry parts, parallelize transfers, or persist a
resumable session. A SAS is scoped to the staging blob, not cryptographically to
one block ID or size, so server-side verification remains essential.

Abort prevents completion and deletes committed staging. Azure may retain
uncommitted blocks until its automatic garbage collection (normally a week without
further block activity). A still-valid SAS can upload again until expiry. Keep the
uploads lifecycle rule to remove abandoned committed staging and session records.
Large uploads still require a full server-side read during synchronous completion;
configure bandwidth, application upload limits, and gateway/deadline settings accordingly.

### Verification and publication

Completion streams the uploaded bytes from Azure, computes their SHA-256, and
checks their size. It never trusts client-provided checksum metadata or an Azure
ETag as a content digest. Downloads are conditional on the observed ETag, including
SDK retries. Encoded blobs are rejected so a decoded HTTP response cannot be
mistaken for the actual stored bytes.

Before publication, the provider copies the verified source into destination
blocks. It checks the source ETag before copying and after all copies finish,
then atomically commits the destination. A source change during that interval
prevents publication. Changes after the last check cannot alter already-copied
destination blocks.

A private `session.json` sibling records the expected identity and the pending,
completed, or aborted state. The browser's SAS grants access only to `object`.
Completion records success before deleting staging. Repeated and concurrent
completion calls can recover across processes using that receipt, even after
staging is gone. Receipt retention should cover the application's retry window;
the uploads lifecycle rule eventually reclaims these records too.

Aborting is idempotent and records an aborted state before deleting staging.
Deleting the object does not revoke an outstanding SAS: it can recreate staging
until expiry, but the aborted session cannot complete. A completed session cannot
be aborted. A race or crash can leave verified final content that is not attached
to a record; `BlobStorage` does not currently define final-content garbage collection.

### Completion resource limits

Each completion requires one full Azure-to-server download and SHA-256 calculation,
plus server-side copy operations. Budget server bandwidth/CPU and Azure read/copy
costs accordingly. The synchronous completion endpoint must have an API/gateway
timeout longer than the chosen completion deadline.

`completionConcurrency` bounds active completions per provider instance. Additional
calls receive a capacity error. Direct provider callers can retry completion;
the standard `uploadFile` helper aborts failed sessions, so retrying that helper
starts a new upload. Applications controlling upload concurrency should keep within
this bound. `completionTimeoutMillis` cancels verification/publication
when the deadline expires. Cleanup failures are logged separately, and a durable
completion receipt allows recovery when the outcome was already recorded.

### Managed identity and SAS signing

With token credentials, browser SAS URLs use Azure user-delegation keys. The
provider caches keys and coalesces concurrent refreshes. In addition to data access,
the identity needs `generateUserDelegationKey/action` at storage-account scope or
above. A focused role assignment is:

- **Storage Blob Data Contributor** on the container.
- **Storage Blob Delegator** on the storage account.

Container-scoped contributor alone cannot obtain a delegation key. Account-scoped
Data Contributor also supplies the required delegation permission.

Shared-key connection strings sign service SAS URLs directly. SAS URLs grant
create/write on one staging blob, use HTTPS for Azure, and expire at the requested
time. Signing backdates the start by five minutes for clock skew; account-level
SAS expiration policies must allow that signed interval. Shared-key copy-source
SAS URLs also include a signed start: five minutes before signing, with expiry one
hour after signing. An enforced account policy must therefore allow a 65-minute
interval for these internal read URLs.

### Browser CORS

Configure CORS on the Azure **Blob service**, through infrastructure:

| Setting | Value |
| --- | --- |
| Allowed origins | Your application's exact origin(s) |
| Allowed methods | `PUT` |
| Allowed headers | `content-type`, `x-ms-blob-type` |
| Exposed headers | Optional `ETag`; direct-PUT completion does not require it |

The browser must be able to reach the Blob endpoint; a SAS does not bypass network
restrictions. The provider neither changes service CORS nor provisions containers.

## Tests

```bash
bun --filter @sixb/blob-azure test
bun --filter @sixb/blob-azure typecheck
bun --filter @sixb/blob-azure test:e2e
```

E2E tests start a pinned Azurite container through Docker Compose, provision an
isolated test container, and run the shared Sixb storage contract plus Azure-specific
streaming, concurrency, cancellation, and publication tests. The fixture uses
localhost port `49010` and tears down its containers afterward.

Azurite exercises shared-key storage, SAS uploads, CORS preflight, and a 26 MiB
upload through both single-PUT and multipart paths in the standard client and Files API
under Bun. Session-limit tests exercise sizes above 5,000 MiB without transferring
multi-gigabyte fixtures. That API integration
test also uses localhost port `49011`. Unit tests cover user-delegation key caching
and signing. Managed identity, Azure RBAC, and private-source bearer authorization
still require verification against a real Azure account; live verification is
deferred for this delivery.
