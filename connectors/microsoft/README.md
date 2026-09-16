# @sixb/connector-microsoft

Typed Microsoft Graph v1.0 connector for Sixb. Covers SharePoint Online sites, document libraries,
files, folders, Outlook mail, calendars and incremental synchronization. Uses `@sixb/connector-rest` for HTTP and Microsoft's
`@azure/msal-node` for application authentication. Targets the global Microsoft 365 cloud.

## Quick start

```ts
// connectors/microsoft.ts
import { defineConnector } from "@sixb/core"
import { microsoft } from "@sixb/connector-microsoft"

export default defineConnector("microsoft", microsoft({
  auth: {
    tenantId: process.env.MICROSOFT_TENANT_ID!,
    clientId: process.env.MICROSOFT_CLIENT_ID!,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET!,
  },
}))
```

For a standalone script, connect the adapter directly:

```ts
import { microsoft } from "@sixb/connector-microsoft"

const controller = new AbortController()
const client = await microsoft({
  auth: {
    tenantId: process.env.MICROSOFT_TENANT_ID!,
    clientId: process.env.MICROSOFT_CLIENT_ID!,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET!,
  },
}).connect({ projectId: "demo", connectorId: "microsoft", signal: controller.signal })

const site = await client.sites.getByUrl("https://contoso.sharepoint.com/sites/Operations")
for await (const drive of client.sites.listAllDrives(site.id)) {
  for await (const item of client.drives.items.listAllChildren(drive.id)) {
    console.log(item.id, item.name)
  }
}
```

`getByUrl` accepts the actual site URL, not a sharing link or a library view URL. File paths supplied
to `getByPath` are unencoded and relative to the library root. Use IDs for stable references across
renames. `"root"` is accepted wherever a folder/item ID is expected; moves resolve its real ID.

## Administrator setup

1. In Entra **App registrations**, create a single-tenant application in the target organization.
   Record its **Directory (tenant) ID** and **Application (client) ID**. No redirect URI or Microsoft
   publisher review is needed for this server-to-server setup.
2. Add a certificate, or create a client secret. For a secret, retain its **value**, not its ID.
3. Under **API permissions**, add **Microsoft Graph → Application permissions → Sites.Selected**.
   A suitably privileged Entra administrator must grant admin consent. An ordinary user, site owner,
   or application owner alone cannot grant this Graph application consent.
4. Grant the application `read` or `write` on each selected site. Consent to `Sites.Selected` alone
   grants no data access. Provisioning is performed by a separately authorized administrator/tool;
   the runtime connector does not grant itself additional permissions.

The site grant uses Graph's `POST /sites/{siteId}/permissions` endpoint:

```json
{
  "roles": ["write"],
  "grantedToIdentities": [{
    "application": {
      "id": "APPLICATION-CLIENT-ID",
      "displayName": "Sixb"
    }
  }]
}
```

This provisioning endpoint requires its own administrative permissions, described in the
[site permission API](https://learn.microsoft.com/en-us/graph/api/site-post-permissions?view=graph-rest-1.0).
Do not add broad permission-management rights to the runtime app to perform this step.
See [Selected permissions](https://learn.microsoft.com/en-us/graph/permissions-selected-overview) and
[admin consent](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/grant-admin-consent).
The configured identity operates as the application, without user impersonation or daily sign-in.

## Authentication

Choose exactly one mode. Credential discovery is never implicit.

- **Client secret**: `{ tenantId, clientId, clientSecret }`.
- **Client certificate**: `{ tenantId, clientId, clientCertificate: { thumbprintSha256, privateKey } }`.
  Upload the public certificate in Entra. Supply its 64-character hexadecimal SHA-256 fingerprint
  and matching PEM RSA private key to the connector. Keep the private key in a secret store.
- **Token resolver**: `{ token: ({ signal, forceRefresh }) => Promise<string> }`.
  The caller supplies a Graph token and owns its lifetime. Suitable for delegated access, managed
  identity or federation through the appropriate Microsoft identity library. On `forceRefresh`,
  bypass any caller-owned token cache. Honor `signal` during acquisition.

MSAL owns token caching, renewal and certificate signing for the credential modes. Concurrent
acquisitions are coalesced. Application tokens request `https://graph.microsoft.com/.default`;
permissions come from the administrator's configuration, not a scopes array in application code.
A read receiving `401` refreshes once; `403` is returned without changing tokens.

`timeoutMs` defaults to 30 seconds per HTTP attempt (auth, Graph and media). `minDelayMs` and `retry`
use the REST connector's policies; reads default to two retries and respect `Retry-After`.
The connection's `AbortSignal` applies throughout. Individual methods also accept `signal`.
MSAL 6's default token POST transport does not expose a timeout: the connector uses its supported
`networkClient` extension with Sixb REST, including timeout and cancellation. No MSAL fork is used.

## Files and folders

```ts
const root = await client.drives.items.get(driveId, "root")
const folder = await client.drives.items.createFolder(driveId, root.id, "Reports")
const file = await client.drives.uploads.upload(
  driveId,
  { parentId: folder.id, name: "report.pdf" },
  Bun.file("./report.pdf")
)

await Bun.write("./downloaded.pdf", await client.drives.items.download(driveId, file.id))
await client.drives.items.rename(driveId, file.id, "report-final.pdf", { ifMatch: file.eTag })
await client.drives.items.move(driveId, file.id, "root")
await client.drives.items.delete(driveId, file.id)
```

`download` returns bytes. For large downloads, `downloadResponse` returns a streaming `Response`:
consume it with `Bun.write(destination, response)` or cancel its body. Tokens never follow media
redirects. Authenticated pagination links are restricted to the configured global Graph v1.0 origin.

New files/folders default to conflict behavior `fail`. File uploads also accept `replace` and `rename`;
folder creation accepts `rename`. Uploading to `{ itemId }` replaces that file's content by default.
Use `ifMatch` on rename/move/delete to detect concurrent edits (`412`). For uploads, Graph checks
`ifMatch` when creating the session; this connector does not promise a lock against edits made
after session creation or a second conditional check at final commit.
Mutations are single-attempt even with a custom retry policy: a timeout does not establish whether
the write took effect. Read the destination state before deciding to repeat it.

## Resumable uploads

`upload` accepts a `Blob` (including `Bun.file`), `Uint8Array`, or `ArrayBuffer`. Small files use a
binary PUT; files above 10 MiB use sessions and 10 MiB fragments. A conditional upload uses a session
even when small, preserving the documented session `If-Match` contract. Conditional empty uploads
are rejected rather than silently dropping the condition. Unconditional empty files are supported.
The random-access content requirement makes interrupted transfers resumable without buffering a
whole `Bun.file` in memory. Arbitrary unknown-length streams are not accepted.

```ts
const session = await client.drives.uploads.createSession(driveId, {
  parentId: "root", name: "archive.zip",
})
// Persist session securely if needed; uploadUrl is itself a credential.
await client.drives.uploads.resume(session, Bun.file("./archive.zip"))
// Alternatively: getStatus(session), or cancel(session).
```

On transient PUT failures or `416`, the transfer queries server state before resending. Recovery
attempts are bounded. Fragments use the configured size, independently of the missing range ends
reported by Graph. `MicrosoftUploadError` preserves the latest acknowledged session expiry and
ranges along with the underlying cause. If
`completionUnknown` is true, the final write may have completed: reconcile the destination before
starting another upload. The connector never silently replaces an expired or missing session.
Resume with the exact same complete file. Sessions remain available on failure until cancellation
or server expiry. Preauthenticated session URLs receive no Graph token and are not logged by the
connector; avoid logging entire sessions, errors or provider bodies yourself.

## Incremental synchronization

Use `delta.pages` for initial enumeration as well as subsequent changes. Folder listing is intended
for navigation; concurrent writes make it unsuitable for establishing a complete sync snapshot.

```ts
// cursor is undefined on first sync. Store it together with its drive and local sync state.
for await (const page of client.drives.delta.pages(driveId, { cursor })) {
  // Apply partial item updates by ID and stage deletions, including folder deletions.
  // In one storage transaction, persist those changes and the following checkpoint.
  // At the final deltaLink, also finalize deletions: remove folders only once empty.
  const nextCursor = page["@odata.nextLink"] ?? page["@odata.deltaLink"]
  await applyAndCheckpoint(page.value, nextCursor, {
    finalPage: page["@odata.deltaLink"] !== undefined,
  })
}
```

Process all pages, including empty pages. Graph may return an item more than once; apply changes
idempotently by ID, with the last occurrence taking precedence. Defer folder deletion until all
pages have been applied, then remove only empty folders; persist pending deletions across resumed
runs. `applyAndCheckpoint` above is application-owned storage logic. When using `select`, retain
the facets your synchronization needs, including `deleted`, `folder` and `parentReference`.
The final `deltaLink` is the checkpoint for the next run. Cursors are opaque URLs:
do not reconstruct their query strings or combine a saved cursor with new query options.
For changes-only initialization, use `delta.list(driveId, { token: "latest" })`.
`410` is exposed as `MicrosoftApiError` with `code` and `location`: it requires an explicit full
resynchronization and local-state reconciliation, not an automatic checkpoint reset.

## Outlook mail

The `mail` surface uses the same authentication configuration. Each method takes a mailbox Entra
user ID or UPN explicitly; app-only calls use `/users/{id-or-UPN}`, never `/me`. No directory-wide
user lookup or SharePoint permission is required for mail operations.

For Microsoft 365 application access, an Exchange administrator assigns `Application Mail.ReadWrite`
and, for sending, `Application Mail.Send`, restricted to the approved mailboxes using
[Exchange Application RBAC](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac).
Do not also grant unscoped Entra mail permissions: those grants are additive and bypass the mailbox
restriction. RBAC permissions need not appear as token roles; the connector lets Exchange authorize
each request. Permission propagation may take 30 minutes to two hours.

```ts
const mailbox = "operations@contoso.com"
const draft = await client.mail.messages.createDraft(mailbox, {
  subject: "Proposal",
  body: { contentType: "text", content: "Please find the proposal attached." },
  toRecipients: [{ emailAddress: { address: "recipient@example.com" } }],
})
await client.mail.attachments.upload(mailbox, draft.id, "proposal.pdf", Bun.file("./proposal.pdf"))
const submission = await client.mail.messages.send(mailbox, draft.id)
// submission.status === "accepted": this does not establish delivery.
```

| Surface | Operations |
| --- | --- |
| `mail.messages` | `list`, `listAll`, `listInFolder`, `listAllInFolder`, `get`, `getMime`, `update`, `createDraft`, `updateDraft`, `createReply`, `createReplyAll`, `createForward`, `send`, `sendMail`, `move`, `copy`, `delete` |
| `mail.folders` | `list`, `listAll`, `get`, `listChildren`, `listAllChildren`, `create`, `rename`, `delete` |
| `mail.attachments` | `list`, `listAll`, `get`, `downloadResponse`, `download`, `upload`, `delete`, `createSession`, `resume`, `cancel` |
| `mail.messages.delta` | `list`, `pages` per mailbox and folder |
| `mail.folders.delta` | `list`, `pages` per mailbox |

`folders.listAll` paginates the top-level collection; use `listAllChildren` to traverse subfolders.
Set `includeHiddenFolders: true` when hidden folders are required. `messages.listAll` covers the
mailbox message collection; `listAllInFolder` limits the collection to one folder.

### Message identity, reads and writes

All mail Graph requests, including continuation pages, carry `Prefer: IdType="ImmutableId"`. IDs
are case-sensitive and stable across moves within the same mailbox. Persist the tenant, mailbox
and message ID together. Copies have their own IDs; archive-mailbox moves and export/reimport can
change identity. In-place archive mailboxes are outside the Outlook mail API.

Use `select` for projections; `id` is always retained. Include `internetMessageHeaders` explicitly
when needed. `bodyContentType: "text"` requests text; otherwise Graph owns the returned body format.
`getMime` and `downloadResponse` return streaming responses: consume or cancel their bodies.
`hasAttachments` does not include inline-only attachments; list attachments when those are needed.
Attachment types distinguish files, attached Outlook items and cloud references. `/$value` returns
bytes/MIME for the first two; cloud reference downloads expose Graph's `405` rather than silently
following an unrelated URL.

`filter`, `search` and `orderBy` use Graph expressions. Search is a bounded provider search, not an
exhaustive synchronization API, and cannot be combined with filter/orderBy here. Graph may reject
unsupported filter/sort combinations with `InefficientFilter`; the connector preserves that error.

`update` accepts message metadata (read state, categories, flags, importance). `updateDraft` also
accepts subject, body and recipients; Graph enforces which fields can change on a draft. There is
no preliminary read that could introduce a false concurrency guarantee. No mail `ifMatch` contract
is advertised. `createReply`, `createReplyAll` and `createForward` create drafts for later review or
sending. For a forward, supply `toRecipients`. Use `move(..., "deleteditems")` for an explicit move
to trash; `delete` delegates to Graph DELETE and is subject to Exchange retention rules.

`send` and `sendMail` return `{ status: "accepted", requestId? }` after a `202` response. They never
claim delivery or invent a message ID. A draft's immutable ID can locate its eventual Sent Items
copy. `MicrosoftMailSubmissionError.outcomeUnknown` flags an interrupted HTTP submission. Reconcile
the draft/Sent Items before retrying; absence immediately after sending is not proof of failure.
All mutations are single-attempt, including after 401/429/5xx. There is no exactly-once send guarantee.

### File attachments and interrupted uploads

Files below 3 MiB use base64 JSON; 3–150 MiB files use Outlook sessions with sequential 3.125 MiB
fragments. Exchange message limits can be lower than the attachment API maximum. Inline files
require `isInline: true` and a `contentId` matching the message body's `cid:` reference. Uploads
accept `Blob` (including `Bun.file`), `Uint8Array` or `ArrayBuffer`; unknown-length streams are not
supported. The returned `{ id }` can be used with the attachment methods. Large uploads obtain it
from Outlook's final Location header; this URL is parsed, never fetched with Graph credentials.

`MicrosoftMailUploadError` retains the last acknowledged session and its offsets. `resume` sends
the same complete file from that position; `cancel` discards the session. PUTs are not implicitly
replayed. If the last acknowledgement was lost, the saved offset may be stale and Outlook can
reject a resumed fragment. If `completionUnknown` is true, inspect the draft's attachments before
starting another upload. The connector does not invent an undocumented status endpoint or create
a replacement session automatically. Session URLs are credentials: store securely and do not log
whole sessions or upload errors. Microsoft documents a known issue with large uploads to shared
or delegated mailboxes; validate that scenario on the target tenant before relying on it.

### Mail delta

Use `mail.messages.delta.pages(mailbox, folderId, options)` for initial enumeration and subsequent
changes. Persist a cursor separately for each folder. `mail.folders.delta.pages(mailbox, options)`
tracks folder hierarchy changes. Process every page, including empty ones, before advancing its
checkpoint. Persist data changes and checkpoints consistently in application-owned storage.

Message delta supports select/top/expand, changeType, a receivedDateTime ge/gt filter and
`receivedDateTime desc` ordering. Folder delta exposes select and the pageSize header. Cursors
remain opaque; new query options cannot be added to a saved cursor. Retain the same projection
context and body preference when resuming. Do not reinterpret `@removed` as mailbox-wide deletion:
a message may simply have moved out of the tracked folder. Apply updates idempotently and reconcile
folder membership across independent streams. Invalid/expired delta state is propagated (including
410); a full resync must be an explicit application decision.

Reads honor REST retry policies and Retry-After. Pace work per mailbox: Outlook allows four
concurrent requests per application/mailbox, and minDelayMs only spaces starts, not in-flight
concurrency. Sequential per-mailbox processing is a safe default; coordinate across workers.
The connector does not install background polling, subscriptions or a persistent sync store.
Calendar/Teams operations, rules, mailbox settings and MIME composition are outside this surface.

### Mail verification

```bash
bun test connectors/microsoft/tests/mail.test.ts connectors/microsoft/tests/mail-attachments.test.ts
```

The opt-in live test requires `MICROSOFT_MAIL_E2E=1`, `MICROSOFT_TENANT_ID`, `MICROSOFT_CLIENT_ID`,
`MICROSOFT_CLIENT_SECRET`, `MICROSOFT_MAIL_TEST_MAILBOX` (ID/UPN), and
`MICROSOFT_MAIL_DENIED_MAILBOX` (an existing mailbox outside the application scope). It creates
unique test drafts/folders, transfers small/large binary files, verifies immutable IDs after moving,
checks delta and cleans up. Set `MICROSOFT_MAIL_TEST_RECIPIENT` only to a consenting test address
to also send a test email. Accepted sent messages remain for delivery verification and manual
cleanup. Ordinary tests send no mail; the live suite skips unless explicitly enabled.

```bash
bun test ./connectors/microsoft/tests/mail.e2e.ts
```

## API surface and limits

- `sites`: `get`, `getByUrl`, `listDrives`, `listAllDrives`.
- `drives`: `get`; `items`: `get`, `getByPath`, `listChildren`, `listAllChildren`, `download`,
  `downloadResponse`, `createFolder`, `rename`, `move`, `delete`.
- `drives.uploads`: `upload`, `createSession`, `getStatus`, `resume`, `cancel`.
- `drives.delta`: `list`, `pages`.

Collection responses retain Graph's `value` and annotations. Select/expand options preserve wire
properties; projections include `id` so item identity remains available. Wire types cover the
properties used by this surface, not the complete Graph schema. Optional fields may be absent.
`MicrosoftApiError` exposes status, code, requestId, retryAfter, location and the provider body.

Microsoft Graph cannot directly move files between libraries; `move` stays in one drive. Graph
also rejects replacing sensitivity-labelled file content with app-only authentication; Microsoft
requires delegated access for that operation. Retention rules and other SharePoint policies still
apply. Sovereign clouds, on-premises SharePoint, permission provisioning, cross-drive copy jobs,
webhooks and Office document-content editing are outside this package's current surface.

## Verification

```bash
bun test connectors/microsoft/tests/
bun --filter @sixb/connector-microsoft typecheck
bun --filter @sixb/connector-microsoft build
```

Tests execute real MSAL with mocked HTTP responses, verify RSA certificate assertions, exercise
pagination and credential boundaries, and simulate failed/ambiguous uploads. The opt-in live suite
requires `MICROSOFT_TENANT_ID`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_SITE_URL`
and `MICROSOFT_TEST_DRIVE_ID`. Optionally set `MICROSOFT_TEST_PARENT_ID` (defaults to the drive root).
Use a test library with application write access. The suite creates a uniquely named folder,
uploads small/empty/large files and deletes that folder in cleanup (SharePoint recycle-bin rules
apply). It skips when credentials are missing.

```bash
bun --filter @sixb/connector-microsoft test:e2e
```

## Outlook calendars

`client.calendar` uses the existing application authentication and explicit mailbox ID/UPN.
Assign **Application Calendars.ReadWrite** through Exchange Application RBAC to the approved
mailboxes. Do not also grant an unrestricted Entra `Calendars.ReadWrite` permission: the grants
are additive. Calendar invitations and responses use the calendar permission; `Mail.Send` is
only needed for the separate mail API. No interactive sign-in or new app registration is needed.

```ts
const { calendar } = client
const primary = await calendar.calendars.getDefault("organizer@contoso.com")
const work = await calendar.calendars.create("organizer@contoso.com", "Project work")

const appointment = await calendar.events.create("organizer@contoso.com", {
  subject: "Project review",
  start: { dateTime: "2026-11-02T09:00:00", timeZone: "Eastern Standard Time" },
  end: { dateTime: "2026-11-02T10:00:00", timeZone: "Eastern Standard Time" },
  transactionId: crypto.randomUUID(), // Persist and reuse for this logical creation.
}, { calendarId: work.id })

for await (const event of calendar.view.listAll("organizer@contoso.com", {
  calendarId: work.id,
  startDateTime: "2026-11-01T00:00:00-04:00",
  endDateTime: "2026-12-01T00:00:00-05:00",
  timeZone: "Eastern Standard Time",
})) {
  console.log(event.id, event.subject, event.start)
}
```

| Surface | Operations |
| --- | --- |
| `calendar.calendars` | `list`, `listAll`, `get`, `getDefault`, `create`, `update`, `delete` |
| `calendar.events` | `list`, `listAll`, `get`, `create`, `update`, `delete`, `instances`, `allInstances` |
| Meeting actions | `events.accept`, `tentativelyAccept`, `decline`, `forward`, `cancel` |
| `calendar.view` | `list`, `listAll`, `delta.list`, `delta.pages` |
| `calendar.attachments` | `list`, `listAll`, `get`, `downloadResponse`, `download`, `upload`, `delete`, `createSession`, `resume`, `cancel` |
| Availability | `calendar.getSchedule` |

### Events, meetings and dates

- Event lists contain single events and recurrence masters. Use `view` for occurrences and
  exceptions in a period, or `events.instances` for one series. Pass an occurrence ID to edit or
  cancel that instance; pass the master ID to change the series. Graph enforces recurrence boundaries.
- Writes use local `dateTime` plus `timeZone`, preserved without machine-timezone conversion.
  Use a timezone supported by the mailbox (for example `Eastern Standard Time`). Range queries
  require explicit UTC/offset timestamps; `timeZone` controls response rendering, not range boundaries.
- An all-day write with `isAllDay: true` must include start/end at midnight in the same zone,
  with the end on the following day (or later for multiple days). DST days need not last 24 hours.
  Server validation still applies to partial updates and mailbox-specific timezone rules.
- Creating an event with attendees **sends invitations**; there is no mail-style draft/send step.
  Updates can notify attendees. Deleting an organizer's meeting sends cancellations; `cancel`
  is organizer-only and supports a custom comment. RSVP defaults to sending a response unless
  `sendResponse: false`; a new time proposal on decline/tentative acceptance requires a response.
- Add `isOnlineMeeting: true` and `onlineMeetingProvider: "teamsForBusiness"` to create a Teams
  meeting when the calendar's `allowedOnlineMeetingProviders` and tenant licensing allow it.
  Read `onlineMeeting.joinUrl`. Before replacing a meeting body, retrieve it and preserve its
  existing Teams HTML. The connector performs no hidden read/merge and offers no concurrency guarantee.
- Event IDs use `IdType="ImmutableId"` on reads, writes and continuation requests. Container
  calendar IDs are already stable. An `iCalUId` identifies the meeting across calendars; it is
  not a Graph event ID and differs between recurring occurrences.
- Mutations are never automatically replayed. Persist a `transactionId` for event creation;
  reuse it when reconciling an uncertain result. `MicrosoftCalendarMutationError.outcomeUnknown`
  marks an interrupted HTTP mutation, including creates/updates/deletes and meeting actions.
  HTTP errors retain `MicrosoftApiError`. A `202` action result means accepted, not delivery.

Calendar attachments reuse the Outlook upload protocol described above, targeting event IDs.
After adding an attachment, the organizer can update the event to distribute it to attendees;
`upload` does not issue that additional update. `MicrosoftCalendarUploadError` preserves the
acknowledged session and `completionUnknown`. Apply the same resume, credential-handling and
shared/delegated-mailbox large-upload limitations as for mail.

`getSchedule` returns availability and individual `error` records keyed by `scheduleId`; do not
interpret an error as free time. It accepts up to 20 entities (including distribution-list members)
and a period shorter than 62 days. The connector validates explicit input counts and same-zone
local ranges; Graph validates expanded lists and actual zoned intervals. It is a read-only POST
and follows the transport's conservative no-POST-retry policy. `findMeetingTimes` does not support
application authentication and is not exposed.

### Calendar delta

Graph v1.0 documents delta for **the primary calendar over a fixed time range**. It does not
provide the beta calendar-list or secondary-calendar delta APIs on this surface. Use paginated
`view` reads for secondary calendars; a changed time range requires a new initial delta round.

```ts
for await (const page of client.calendar.view.delta.pages("organizer@contoso.com", {
  startDateTime: "2026-11-01T00:00:00Z",
  endDateTime: "2026-12-01T00:00:00Z",
  timeZone: "Eastern Standard Time",
  pageSize: 100,
})) {
  // Apply this page before persisting its nextLink (resume) or deltaLink (completed round).
  // Store the cursor with tenant, mailbox, fixed range and response timezone.
}
// Resume using { cursor: savedUrl, timeZone: savedTimeZone }; never edit the opaque URL.
```

Delta does not accept `select`, `expand`, `filter`, `orderBy`, `search`, `top` or `calendarId`.
Pagination retains headers and follows empty pages. `@removed` is preserved and can refer to
changes outside the tracked period: it is not proof that the event was deleted from the mailbox.
Expired checkpoints surface as Graph errors; starting over and reconciling the local view are
caller responsibilities. This connector does not store checkpoints or run background synchronization.

Microsoft 365 group calendars, calendar sharing permissions, calendar groups, reminder actions,
standalone Teams meeting APIs and webhooks are outside this surface.

### Calendar live verification

Unit tests mock Graph. The E2E explicitly writes test calendars/events and **sends an invitation,
an acceptance and a cancellation** between two dedicated test accounts. It deletes its own
calendars/events afterward; Outlook can retain the associated notification emails.

Run `MICROSOFT_CALENDAR_E2E=1 bun test ./connectors/microsoft/tests/calendar.e2e.ts` with:

- `MICROSOFT_TENANT_ID`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`.
- `MICROSOFT_CALENDAR_TEST_MAILBOX`: a dedicated organizer mailbox within the RBAC scope.
- `MICROSOFT_CALENDAR_TEST_ATTENDEE`: a different, consenting test mailbox within the scope.
- `MICROSOFT_CALENDAR_DENIED_MAILBOX`: an existing mailbox outside the scope (must return 403).
- Optional `MICROSOFT_CALENDAR_TEST_TEAMS=1`: also verify a Teams join link on a licensed organizer.

The test covers secondary-calendar CRUD, a recurrence exception, all-day events, binary small/large
attachments, primary-calendar delta, availability and the organizer's received acceptance. It
requires an Exchange Online tenant; passing mocked tests does not establish live compatibility.
If cleanup fails after a network interruption, use the unique `sixb-calendar-e2e-...` subject/name
reported by the test to remove remaining test data.

## Microsoft API references

- [App-only authentication](https://learn.microsoft.com/en-us/graph/auth-v2-service)
- [MSAL token acquisition](https://learn.microsoft.com/en-us/entra/msal/javascript/node/acquire-token-requests)
- [Sites by path](https://learn.microsoft.com/en-us/graph/api/site-getbypath?view=graph-rest-1.0)
- [Document libraries](https://learn.microsoft.com/en-us/graph/api/drive-list?view=graph-rest-1.0)
- [Path addressing](https://learn.microsoft.com/en-us/graph/onedrive-addressing-driveitems)
- [Children](https://learn.microsoft.com/en-us/graph/api/driveitem-list-children?view=graph-rest-1.0)
- [Download](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0)
- [Binary upload](https://learn.microsoft.com/en-us/graph/api/driveitem-put-content?view=graph-rest-1.0)
- [Upload sessions and recovery](https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession?view=graph-rest-1.0)
- [Create folder](https://learn.microsoft.com/en-us/graph/api/driveitem-post-children?view=graph-rest-1.0)
- [Rename/update](https://learn.microsoft.com/en-us/graph/api/driveitem-update?view=graph-rest-1.0)
- [Move](https://learn.microsoft.com/en-us/graph/api/driveitem-move?view=graph-rest-1.0)
- [Delete](https://learn.microsoft.com/en-us/graph/api/driveitem-delete?view=graph-rest-1.0)
- [Delta synchronization](https://learn.microsoft.com/en-us/graph/api/driveitem-delta?view=graph-rest-1.0)

- [Outlook mail overview](https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview?view=graph-rest-1.0)
- [Message listing](https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0)
- [Message updates](https://learn.microsoft.com/en-us/graph/api/message-update?view=graph-rest-1.0)
- [Draft replies](https://learn.microsoft.com/en-us/graph/api/message-createreply?view=graph-rest-1.0)
- [Draft forwards](https://learn.microsoft.com/en-us/graph/api/message-createforward?view=graph-rest-1.0)
- [Send mail](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0)
- [Immutable IDs](https://learn.microsoft.com/en-us/graph/outlook-immutable-id)
- [Mail folders](https://learn.microsoft.com/en-us/graph/api/user-list-mailfolders?view=graph-rest-1.0)
- [Mail attachments](https://learn.microsoft.com/en-us/graph/api/attachment-get?view=graph-rest-1.0)
- [Outlook large attachments](https://learn.microsoft.com/en-us/graph/outlook-large-attachments)
- [Message delta](https://learn.microsoft.com/en-us/graph/api/message-delta?view=graph-rest-1.0)
- [Folder delta](https://learn.microsoft.com/en-us/graph/api/mailfolder-delta?view=graph-rest-1.0)
- [Outlook throttling](https://learn.microsoft.com/en-us/graph/throttling-limits#outlook-service-limits)

- [Calendar resource](https://learn.microsoft.com/en-us/graph/api/resources/calendar?view=graph-rest-1.0)
- [Create event](https://learn.microsoft.com/en-us/graph/api/user-post-events?view=graph-rest-1.0)
- [Update event and meeting notifications](https://learn.microsoft.com/en-us/graph/api/event-update?view=graph-rest-1.0)
- [Calendar views](https://learn.microsoft.com/en-us/graph/api/calendar-list-calendarview?view=graph-rest-1.0)
- [Calendar delta](https://learn.microsoft.com/en-us/graph/api/event-delta?view=graph-rest-1.0)
- [Meeting cancellation](https://learn.microsoft.com/en-us/graph/api/event-cancel?view=graph-rest-1.0)
- [Meeting responses](https://learn.microsoft.com/en-us/graph/api/event-tentativelyaccept?view=graph-rest-1.0)
- [Teams calendar events](https://learn.microsoft.com/en-us/graph/outlook-calendar-online-meetings)
- [Event attachments](https://learn.microsoft.com/en-us/graph/api/event-post-attachments?view=graph-rest-1.0)
- [Free/busy limits](https://learn.microsoft.com/en-us/graph/outlook-get-free-busy-schedule)
