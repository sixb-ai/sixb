# @sixb/connector-google

A typed Google Workspace client for Sixb, built on `@sixb/connector-rest`. Like every Sixb
connector it is a **typed bridge** to the external system — it does not store, sync, parse, or
project data. Datasets, syncs, and projections are wired project-side by the consumer.

One package spans Google's many APIs: auth and HTTP conventions live in a shared core, and each
API is a **surface** of declarative typed resources. Adding a surface (e.g. `meet`, `calendar`)
costs a base-URL entry, its resources, and one wiring line — the auth/HTTP core never changes.

Surfaces implemented: **`drive`** (v3).

## Usage

```ts
import { defineConnector } from "@sixb/core"
import { google } from "@sixb/connector-google"

export const googleConnector = defineConnector(
  "google",
  google({
    auth: {
      serviceAccountKey: process.env.GOOGLE_SA_KEY!, // parsed object or its JSON string
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    },
  })
)
```

```ts
const client = await googleConnector.adapter.connect(ctx)

await client.drive.files.list({ q: "'FOLDER_ID' in parents and trashed = false" })
for await (const file of client.drive.files.listAll({ q })) { /* ... */ }
await client.drive.files.get(fileId, { fields: "id, name, modifiedTime" })
const bytes = await client.drive.files.export(fileId, "text/plain")

// Incremental change feed — the caller persists the page token as its checkpoint.
const { startPageToken } = await client.drive.changes.getStartPageToken()
for await (const change of client.drive.changes.listAll({ pageToken: startPageToken })) { /* ... */ }
```

## Auth

Two modes (a discriminated union):

- **Service account** — `{ serviceAccountKey, scopes, subject? }`. The connector mints and
  refreshes OAuth tokens (JWT-bearer, signed with the SA key via Web Crypto). Tokens are cached,
  refreshed on a 60s expiry margin, and concurrent refreshes are single-flighted into one
  exchange. `subject` impersonates **one fixed user** (domain-wide delegation); per-request
  impersonation is out of scope.
- **Token resolver** — `{ token: () => Promise<string> }`. You mint the token elsewhere (user
  OAuth, a vault, another service) and own scopes + refresh; the connector just calls it.

A missing scope surfaces as Google's `403` (`GoogleApiError`); it does not churn the token. A
`401` invalidates the cached token and retries once with a fresh one.

## Reading Google Meet transcripts via Drive

Meet transcripts are saved as Google Docs in the organizer's Drive (`Meet Recordings`). To read
them with a service account:

1. Share each organizer's `Meet Recordings` folder with the service account's email (inherited by
   new files), and grant the `drive.readonly` (or narrower `drive.meet.readonly`) scope.
2. Find the Docs with `files.list` (filter by parent folder / `mimeType`), then `files.export`
   them to `text/plain` or `text/markdown`.

Notes: transcription must be started per meeting (or auto-configured); the Drive Doc persists
under normal Drive retention (no 30-day window — that limit only applies to the Meet REST API);
the Doc is prose, so there is no guaranteed per-speaker structure. If structured entries
(speaker/timestamps) are required, that is the Meet REST API surface (not yet implemented) and a
different auth model (per-organizer DWD or user OAuth).
