# @sixb/connector-google

A pair of typed Google clients for Sixb, built on `@sixb/connector-rest`: `google()` for Drive,
Calendar, Gmail, Sheets, and Analytics, and `googleAds()` for read-only Google Ads manager-account
reporting.
Like every Sixb connector they are **typed bridges** to the external system — they do not store,
sync, parse, or project data. Datasets, syncs, and projections are wired project-side by the
consumer.

One package shares Google's three explicit authentication modes. Drive, Calendar, Gmail, Sheets,
and Analytics use one `google()` client with declarative surfaces; Google Ads has a separate
`googleAds()` factory because its developer token, manager context, version lifecycle, and GAQL
transport are distinct.

Surfaces implemented: **`drive`** (v3), **`calendar`** (v3), **`gmail`** (v1), **`sheets`** (v4),
and **`analytics`** with **Admin** (v1beta) plus **Data** (v1beta).

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
const storedBytes = await client.drive.files.download(fileId, { supportsAllDrives: true })
const nativeBytes = await client.drive.files.export(fileId, "text/plain")

// Incremental change feed — the caller persists the page token as its checkpoint.
const { startPageToken } = await client.drive.changes.getStartPageToken()
for await (const change of client.drive.changes.listAll({ pageToken: startPageToken })) { /* ... */ }
```

Use `files.download()` for stored files such as CSV, XLSX, PDF, and images. It returns the file's
raw bytes and supports Shared Drive files with `{ supportsAllDrives: true }` (plus
`acknowledgeAbuse` when needed). Use `files.export()` instead for native Google Docs, Sheets, and
Slides, choosing the desired export MIME type.

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

### Google Sheets (v4)

Sheets is exposed separately from Drive: use Drive to discover spreadsheet files, then pass the
Drive file id as the Sheets `spreadsheetId`. `spreadsheets.get` returns workbook and sheet metadata;
ordinary cell reads should use `spreadsheets.values.get` or `batchGet` rather than requesting full
grid data.

```ts
const spreadsheet = await client.sheets.spreadsheets.get(fileId, {
  fields: "spreadsheetId,properties(title),sheets(properties(sheetId,title,index))",
})

const rows = await client.sheets.spreadsheets.values.get(fileId, "Sales!A1:Z1000", {
  majorDimension: "ROWS",
  valueRenderOption: "UNFORMATTED_VALUE",
  dateTimeRenderOption: "FORMATTED_STRING",
})

const ranges = await client.sheets.spreadsheets.values.batchGet(fileId, {
  ranges: ["Sales!A:Z", "Targets!A:D"],
  valueRenderOption: "FORMULA",
})
```

Google omits empty trailing rows and columns from `ValueRange.values`; callers must not assume that
the returned matrix is rectangular. The render options are passed through unchanged: formatted
values are strings by default, while `UNFORMATTED_VALUE` can return strings, numbers, and booleans.

Enable the Google Sheets API in the credential's Cloud project. Reads accept
`spreadsheets.readonly`, `drive.readonly`, or another compatible Sheets/Drive scope. As with Drive,
the authenticated principal must have access to the target spreadsheet.

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

### Google Analytics (Admin v1beta + Data v1beta)

Analytics is grouped under one evolvable façade: `client.analytics.admin.*` for account/property
discovery and configuration, and `client.analytics.data.*` for reports and audience exports.

For the common read path, `accountSummaries` returns every Analytics account visible to the
authenticated principal together with its property summaries. You can then fetch complete property
records or query each property:

```ts
for await (const summary of client.analytics.admin.accountSummaries.listAll()) {
  console.log(summary.account, summary.displayName)

  for (const property of summary.propertySummaries ?? []) {
    const details = await client.analytics.admin.properties.get(property.property!)
    console.log(details.name, details.timeZone, details.currencyCode)
  }
}

const rows = client.analytics.data.properties.runReportAll("properties/123456789", {
  dateRanges: [{ startDate: "30daysAgo", endDate: "today" }],
  dimensions: [{ name: "date" }, { name: "country" }],
  metrics: [{ name: "sessions" }, { name: "activeUsers" }],
  orderBys: [{ dimension: { dimensionName: "date" } }],
})

for await (const row of rows) {
  console.log(row.dimensionValues, row.metricValues)
}
```

The Admin surface covers all non-deprecated stable v1beta resources: accounts, properties, custom
dimensions and metrics, data streams and measurement protocol secrets, Firebase links, Google Ads
links, key events, access reports, and change history. Deprecated `conversionEvents` and alpha-only
resources are intentionally excluded.

The Data surface includes standard, pivot, batch, realtime, metadata and compatibility reports,
plus audience export creation, discovery and querying. `runReportPages` / `runReportAll` and audience
export `queryPages` / `queryAll` use Google’s `offset` pagination; `limit` is their per-request page
size and may not exceed 250,000. Data API `int64` fields remain strings so values are not truncated.

Use `https://www.googleapis.com/auth/analytics.readonly` for account/property discovery and report
reads. Admin mutations require `https://www.googleapis.com/auth/analytics.edit`. A service account
must also be granted access inside Google Analytics (directly or through a group); assigning Google
Cloud IAM roles alone does not make Analytics accounts visible to it.

## Google Ads manager reporting

Google Ads supports service accounts directly. Add the service account email as a user of the
Google Ads manager account (MCC); for reporting, grant it the **Read-only** Google Ads role. Do not
set `subject`: Google Ads does not require Google Workspace domain-wide delegation for this flow.

Every request needs a developer token from the API Center. The connector also requires the manager
account ID as `loginCustomerId` and sends it on calls routed through the MCC; `listAccessible()` is
the exception because Google explicitly ignores that header there. The operating customer ID in
`client.customer(...)` is deliberately separate: the former establishes the MCC access path, while
the latter selects the advertiser whose data is queried.

```ts
import { defineConnector } from "@sixb/core"
import { GOOGLE_ADS_SCOPE, googleAds } from "@sixb/connector-google"

export const googleAdsConnector = defineConnector(
  "google-ads",
  googleAds({
    auth: {
      serviceAccountKey: process.env.GOOGLE_SERVICE_ACCOUNT_JSON!,
      scopes: [GOOGLE_ADS_SCOPE],
    },
    developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN!,
    // UI form with hyphens is accepted and normalized before it reaches Google.
    loginCustomerId: "123-456-7890",
  })
)
```

The Google Ads OAuth scope is `https://www.googleapis.com/auth/adwords`; Google provides no
read-only variant, so least privilege comes from the service account's Google Ads role.

### Discover clients, then query each advertiser

`listAccessible()` only reports accounts granted **directly** to the authenticated identity. If the
service account was invited only to the MCC, that usually means the MCC itself. `listManaged()`
instead runs the documented `customer_client` GAQL query on the configured manager and yields its
enabled, non-manager descendants at every depth.

Google Ads does not aggregate child metrics on a manager. Query every advertiser ID separately:

```ts
const ads = await googleAdsConnector.adapter.connect(ctx)

console.log(await ads.customers.listAccessible()) // e.g. ["customers/1234567890"]

for await (const account of ads.customers.listManaged()) {
  for await (const row of ads.customer(account.id).reports.customerDaily({
    startDate: "2026-08-01",
    endDate: "2026-08-23",
  })) {
    // int64 values stay strings: impressions, clicks, interactions, costMicros,
    // viewThroughConversions, IDs.
    // conversions and conversion values are fractional-capable numbers.
    console.log(account.currencyCode, row.segments.date, row.metrics.costMicros)
  }
}
```

The built-in report's row grain is `(customer, date)` and it selects additive measures:
impressions, clicks, interactions, cost micros, conversions, conversion value, all conversions,
all conversion value, and view-through conversions. Google omits dates where every selected metric
is zero. Derive CTR/CPC/CVR/ROAS after aggregation instead of summing rates. Costs are denominated
in each account's `currencyCode`; never add them across currencies without conversion. Dates follow
the advertiser's `timeZone`. Google can revise recent conversion data, so downstream syncs should
upsert by `(customerId, date)` and re-read an overlap window rather than treating daily results as
append-only.

### Raw GAQL

The customer-scoped reporting resource stays close to Google's wire API:

```ts
type CampaignRow = {
  readonly campaign?: { readonly id?: string; readonly name?: string }
  readonly segments?: { readonly date?: string }
  readonly metrics?: { readonly impressions?: string; readonly costMicros?: string }
}

const reports = ads.customer("9876543210").reports

for await (const row of reports.searchAll<CampaignRow>({
  query: `SELECT
    campaign.id,
    campaign.name,
    segments.date,
    metrics.impressions,
    metrics.cost_micros
  FROM campaign
  WHERE segments.date DURING LAST_30_DAYS`,
})) {
  // One row per campaign/date because selecting a segment changes the result grain.
}

const firstPage = await reports.search({
  query: "SELECT campaign.id, campaign.name FROM campaign ORDER BY campaign.id",
  searchSettings: { returnTotalResultsCount: true },
})

const batches = await reports.searchStream({
  query: "SELECT campaign.id, campaign.name FROM campaign ORDER BY campaign.id",
})
```

`search()` follows Google's fixed 10,000-row pages; `pageSize` is rejected locally because v25
returns `PAGE_SIZE_NOT_SUPPORTED`. `searchAll()` follows page tokens, keeps the GAQL identical, and
detects repeated tokens. Use `search()` when response metadata such as `totalResultsCount`,
`summaryRow`, or `queryResourceConsumption` matters. REST `searchStream()` mirrors Google's raw
JSON array of batches; because JSON parsing buffers that array, prefer paginated `searchAll()` for
memory-bounded processing.

The default endpoint is `/v25` (minor v25.x releases update that endpoint in place). Override
`apiVersion` deliberately when upgrading major versions; v25 is scheduled to sunset in August
2027. IDs may be passed with or without UI hyphens, and `customers/1234567890` resource names from
`listAccessible()` can be passed directly to `customer()`. `GoogleAdsApiError` exposes `status`,
`requestId`, granular `failures`/`errors`, response headers, and the original response body. Reads
retry network errors, `429`, and `5xx` twice by default. `GoogleAdsProtocolError` identifies a
malformed successful response instead of letting it escape under a trusted wire type. Use
`minDelayMs` and bounded workflow concurrency for the dynamic per-customer and per-developer-token
QPS limits.

For a credentialed smoke test covering direct grants, MCC discovery, Search, SearchStream, and the
daily report, follow the environment setup at the top of `tests/ads.e2e.ts` and run it directly with
Bun. It is intentionally excluded from the unit suite.

Official references:

- [Service-account workflow](https://developers.google.com/google-ads/api/docs/oauth/service-accounts)
- [REST authentication and required headers](https://developers.google.com/google-ads/api/rest/auth)
- [Account discovery and MCC hierarchy](https://developers.google.com/google-ads/api/docs/account-management/listing-accounts)
- [Search and SearchStream](https://developers.google.com/google-ads/api/rest/common/search)
- [REST JSON mappings](https://developers.google.com/google-ads/api/rest/design/json-mappings)
- [Google Ads API error details](https://developers.google.com/google-ads/api/docs/best-practices/understand-api-errors)
- [Zero-metric reporting behavior](https://developers.google.com/google-ads/api/docs/reporting/zero-metrics)
- [Google Ads API versioning and sunset dates](https://developers.google.com/google-ads/api/docs/concepts/versioning)
- [Quotas and rate limits](https://developers.google.com/google-ads/api/docs/best-practices/quotas)

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
