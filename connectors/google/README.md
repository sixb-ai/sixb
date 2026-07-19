# @sixb/connector-google

A typed Google Workspace client for Sixb, built on `@sixb/connector-rest`. Like every Sixb
connector it is a **typed bridge** to the external system — it does not store, sync, parse, or
project data. Datasets, syncs, and projections are wired project-side by the consumer.

One package spans Google's many APIs: auth and HTTP conventions live in a shared core, and each
API is a **surface** of declarative typed resources. Adding a surface (e.g. `meet`, `calendar`)
costs a base-URL entry, its resources, and one wiring line — the auth/HTTP core never changes.

Surfaces implemented: **`drive`** (v3), **`calendar`** (v3).

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

### Writing files

`create` / `update` / `delete` / `copy` cover the write path. Metadata-only writes go
to the plain JSON endpoint (creating a folder is a metadata-only `create`); `content`
selects the media bytes and the upload strategy follows automatically:

- **≤ 5 MiB buffered bytes** → one `multipart/related` request (metadata + bytes).
- **Larger bodies** → a resumable session: bytes stream up in 8 MiB chunks with
  `Content-Range`, honoring `308 Resume Incomplete` (partially persisted chunks are
  re-sent from the server's `Range` offset).
- **`ReadableStream` bodies** stay unbuffered end to end: with `sizeBytes` they take
  the chunked path above; without it they go as a single streaming PUT to the session
  URI.

```ts
// Metadata only (this is also how folders are made).
const folder = await client.drive.files.create({
  name: "Reports",
  mimeType: "application/vnd.google-apps.folder",
})

// Small file: metadata + bytes in one request.
const file = await client.drive.files.create({
  name: "report.csv",
  parents: [folder.id],
  content: { body: csvBytes, mimeType: "text/csv" },
})

// Large blob straight out of Sixb blob storage — streamed, never buffered whole.
const info = await blobs.stat(blobId)
await client.drive.files.create({
  name: "export.parquet",
  parents: [folder.id],
  content: {
    body: await blobs.open(blobId),
    mimeType: "application/octet-stream",
    sizeBytes: info?.sizeBytes,
  },
})

await client.drive.files.update(file.id, { name: "renamed.csv" })           // metadata patch
await client.drive.files.update(file.id, { content: { body: v2Bytes } })    // replace content
await client.drive.files.update(file.id, { addParents: "b", removeParents: "a" }) // move
await client.drive.files.update(file.id, { trashed: true })                 // trash
await client.drive.files.copy(file.id, { name: "report (copy).csv" })
await client.drive.files.delete(file.id)                                    // permanent
```

Writes need a write scope — `drive.file` (files the app created or opened) or full
`drive` for arbitrary files — where the read paths above only need `drive.readonly`.

### Calendar (v3)

The full Calendar API v3: `events`, `calendars`, `calendarList`, `acl`, `settings`, `colors`,
`freebusy`, and `channels`. Requires a Calendar scope (e.g. `calendar.readonly`, `calendar`, or
`calendar.events`).

```ts
// Events — list / read / write / recurring instances / natural-language add.
await client.calendar.events.list("primary", { timeMin, singleEvents: true, orderBy: "startTime" })
for await (const e of client.calendar.events.listAll("primary", { timeMin })) { /* ... */ }
await client.calendar.events.get("primary", eventId)
await client.calendar.events.insert("primary", { summary, start, end }, { sendUpdates: "all" })
await client.calendar.events.patch("primary", eventId, { location: "Room 4" })
await client.calendar.events.delete("primary", eventId)
await client.calendar.events.quickAdd("primary", { text: "Lunch tomorrow 12pm" })
for await (const i of client.calendar.events.instancesAll("primary", recurringEventId)) { /* ... */ }

// Calendars, calendar list, ACLs, settings, colors.
await client.calendar.calendars.get("primary")
for await (const c of client.calendar.calendarList.listAll()) { /* ... */ }
await client.calendar.acl.list("primary")
await client.calendar.settings.get("timezone")
await client.calendar.colors.get()

// Free/busy across calendars.
await client.calendar.freebusy.query({ timeMin, timeMax, items: [{ id: "primary" }] })

// Push notifications: open a channel with any `watch`, close it with `channels.stop`.
const channel = await client.calendar.events.watch("primary", {
  id: crypto.randomUUID(),
  type: "web_hook",
  address: "https://example.com/hook",
})
await client.calendar.channels.stop({ id: channel.id, resourceId: channel.resourceId })
```

List endpoints return `nextSyncToken` on their final page; call `list` (not `listAll`) when you
need it to poll incrementally with `syncToken`. `patch`/`insert`/`update` accept the raw Calendar
resource shapes — the connector relays them without interpretation.

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
