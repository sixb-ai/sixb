# @sixb/connector-google

A typed Google Workspace client for Sixb, built on `@sixb/connector-rest`. Like every Sixb
connector it is a **typed bridge** to the external system — it does not store, sync, parse, or
project data. Datasets, syncs, and projections are wired project-side by the consumer.

One package spans Google's many APIs: auth and HTTP conventions live in a shared core, and each
API is a **surface** of declarative typed resources. Adding a surface (e.g. `meet`, `calendar`)
costs a base-URL entry, its resources, and one wiring line — the auth/HTTP core never changes.

Surfaces implemented: **`drive`** (v3), **`calendar`** (v3), **`gmail`** (v1).

## Usage

```ts
import { defineConnector } from "@sixb/core"
import { google } from "@sixb/connector-google"

export const googleConnector = defineConnector(
  "google",
  google({
    auth: {
      applicationDefault: true,
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

### Gmail (v1)

The complete Gmail REST v1 resource tree is available: profiles and mailbox watches, messages and
attachments, drafts, history, labels, threads, account settings, forwarding addresses, filters,
delegates, send-as aliases and S/MIME certificates, plus client-side encryption identities and key
pairs. Every method keeps Google's `userId` explicit; pass `"me"` for the authenticated mailbox.

```ts
const profile = await client.gmail.users.getProfile("me")

// Search returns lightweight message references; fetch each message for its content.
for await (const ref of client.gmail.messages.listAll("me", {
  q: "from:billing@example.com newer_than:30d",
  labelIds: ["INBOX"],
})) {
  const message = await client.gmail.messages.get("me", ref.id!, { format: "full" })
  // Message payload bodies and attachments are base64url encoded by Gmail.
  console.log(message.payload?.headers)
}

// Send an RFC 2822 message. `raw` must be base64url encoded (without required padding).
await client.gmail.messages.send("me", { raw: encodedRfc2822Message })

// Incremental mailbox processing: persist the final page's `historyId` as the next checkpoint.
let page = await client.gmail.history.list("me", { startHistoryId: checkpoint })
for (;;) {
  for (const change of page.history ?? []) { /* ... */ }
  if (!page.nextPageToken) break
  page = await client.gmail.history.list("me", {
    startHistoryId: checkpoint,
    pageToken: page.nextPageToken,
  })
}
checkpoint = page.historyId ?? checkpoint

// Pub/Sub mailbox notifications.
const watch = await client.gmail.users.watch("me", {
  topicName: "projects/my-project/topics/gmail",
  labelIds: ["INBOX"],
  labelFilterBehavior: "include",
})
await client.gmail.users.stop("me")

// Settings mirror the REST resource hierarchy.
await client.gmail.settings.updateVacation("me", {
  enableAutoReply: true,
  responseSubject: "Out of office",
  responseBodyPlainText: "Back on Monday.",
})
await client.gmail.settings.filters.list("me")
await client.gmail.settings.sendAs.smimeInfo.list("me", profile.emailAddress!)
await client.gmail.settings.cse.keypairs.list("me")
```

Common least-privilege scopes are `gmail.readonly` for mailbox reads, `gmail.modify` for message
and label changes, `gmail.compose` or `gmail.send` for authoring/sending, `gmail.labels` for labels,
`gmail.settings.basic` for general and CSE settings, and `gmail.settings.sharing` for forwarding,
delegation, and send-as administration. Several settings operations are restricted to Google
Workspace accounts and may require domain-wide delegation. The broad `mail.google.com` scope can
permanently delete mail and should only be used when narrower scopes cannot cover the workflow.

`listAll` is provided for every paginated Gmail collection. Call the underlying `list` directly
when the final response carries state you need to retain, notably `history.historyId`. Repeated
query parameters such as `labelIds`, `metadataHeaders`, and `historyTypes` accept arrays and are
encoded as repeated keys, matching the Gmail API contract.

## Auth

Three explicit modes (a discriminated union):

- **Application Default Credentials (recommended)** — `{ applicationDefault: true, scopes }`.
  The official `google-auth-library` discovers credentials from the environment and owns token
  refresh. This supports local ADC created by `gcloud`, `GOOGLE_APPLICATION_CREDENTIALS`
  (including Workload Identity Federation configurations), and service accounts attached to
  Google Cloud workloads. Discovery is lazy: constructing the connector does not read credentials
  or contact a metadata server. Credential-specific request metadata, such as a quota project
  header, is preserved.

- **Service account** — `{ serviceAccountKey, scopes, subject? }`. The connector mints and
  refreshes OAuth tokens (JWT-bearer, signed with the SA key via Web Crypto). Tokens are cached,
  refreshed on a 60s expiry margin, and concurrent refreshes are single-flighted into one
  exchange. `subject` impersonates **one fixed user** (domain-wide delegation); per-request
  impersonation is out of scope.
- **Token resolver** — `{ token: () => Promise<string> }`. You mint the token elsewhere (user
  OAuth, a vault, another service) and own scopes + refresh; the connector just calls it.

A missing scope surfaces as Google's `403` (`GoogleApiError`); it does not churn the token. A
`401` invalidates the cached token and retries once with a fresh one. ADC is never selected
implicitly, so a process cannot silently pick up a developer's ambient Google identity.

### Application Default Credentials

For local development, create user ADC with the scopes your connector needs:

```bash
gcloud auth application-default login \
  --client-id-file=/path/to/oauth-client.json \
  --scopes=https://www.googleapis.com/auth/drive.readonly
```

Google APIs outside Google Cloud, including Drive, Calendar, and Gmail, require a custom OAuth client ID
when adding their scopes to local ADC. The resulting credential contains a refresh token; do not
copy a short-lived access token into project configuration.

In production on Google Cloud, attach a least-privileged user-managed service account to the
workload. Outside Google Cloud, point `GOOGLE_APPLICATION_CREDENTIALS` at a Workload Identity
Federation credential configuration that impersonates the service account used for Workspace
access. Downloadable service-account keys are supported for compatibility, but should be a last
resort.

ADC authenticates an identity; it does not grant that identity access to Workspace data. Share the
target Drive resources with the resolved identity and request the required OAuth scopes. Domain-wide
delegation through `subject` remains available only in service-account-key mode.

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
