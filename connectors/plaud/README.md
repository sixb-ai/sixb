# @sixb/connector-plaud

Read your Plaud recordings, complete transcripts, notes, and original audio from Sixb.
Authorization uses Plaud's official MCP OAuth server. Data reads call Plaud's HTTP API directly;
no MCP process or language model is needed at runtime.

Plaud does **not** offer a public, general-purpose account API. This integration follows the
protocol shipped in `@plaud-ai/mcp` **0.3.13**, inspected on **2026-10-05**. These endpoints
can change without compatibility guarantees.

## Register your deployment

Register a public OAuth client once, using your Sixb API's callback URL:

```ts
import { registerPlaudClient } from "@sixb/connector-plaud/auth"

const { clientId } = await registerPlaudClient({
  clientName: "My Sixb app",
  redirectUris: ["https://api.example.com/auth/connectors/callback"],
})
console.log(clientId) // Save as PLAUD_CLIENT_ID in your deployment configuration.
```

Use `http://localhost:<port>/auth/connectors/callback` for local development. Register up to
four callback URLs; HTTPS is required except on loopback. Keep the client name and callback
host (including its port) within 64 characters. Register again when the deployment host changes.
The returned client ID is public; no client secret is required. Registration does not authorize
a user and should not run on every application startup.

The official MCP OAuth server supports public client registration and PKCE. Plaud's native
client has a fixed callback that rejects Sixb's callback with `REDIRECT_URI_MISMATCH`; do not
reuse its client ID.

## Define and authorize the connector

```ts
// connectors/plaud.ts
import { defineConnector } from "@sixb/core"
import { plaud } from "@sixb/connector-plaud"

export const recordings = defineConnector("plaud", plaud({
  clientId: process.env.PLAUD_CLIENT_ID!,
}))
```

Follow [Sixb OAuth setup](https://docs.sixb.ai/connectors/authentication) to configure
`connectorConnections.encryptionKey` with persistent storage and connect an account through
`useConnectorConnection`. Use `connectorId: "plaud"` and a slot such as `"recordings"`.
Plaud exposes the signed-in user's account for selection.

Sixb owns state, PKCE, encrypted credentials, account connections, and automatic token refresh.
The connector implements only Plaud's authorization, exchange, refresh, and account discovery
protocol. It does not read or modify the official MCP client's token files.

```ts
const client = await sixb.connector(recordings, {
  owner: { type: "project" },
  slot: "recordings",
})

const account = await client.users.current()
const page = await client.recordings.list({ page: 1, pageSize: 100 })

for await (const recording of client.recordings.iterate()) {
  const transcript = await client.transcripts.get(recording.id)
  const notes = await client.notes.list(recording.id)
  // transcript?.content is complete; segments preserves timestamps and speakers.
}
```

## Recordings and content

| Method | Result |
| --- | --- |
| `users.current()` | Account and workspace metadata |
| `recordings.list({ page, pageSize })` | One provider page; page numbers start at 1, minimum page size is 10 |
| `recordings.iterate({ query, dateFrom, dateTo })` | All pages, optionally filtered by name and creation date |
| `recordings.get(id)` | Metadata, signed audio URL, source blocks and note metadata |
| `recordings.export(id)` | Full record with every linked source/note body resolved |
| `transcripts.get(id, { block })` | Complete block text and parsed segments when available; `null` if absent |
| `transcripts.list(id)` | All source blocks with their content resolved |
| `notes.list(id)` | All note tabs, including custom summaries, saved answers and highlights |
| `recordings.downloadAudio(id)` | Streaming `Response` for the audio, using a freshly requested URL |

Transcript block names include `transaction` (default), `transaction_polish`, `outline`, and
`mark_memo`. Unknown block types and provider fields are preserved. Raw JSON content remains
available even if its shape cannot be parsed as timestamped segments. Failed content downloads
throw; they are never silently returned as successful empty exports.

`iterate()` has no 20-record or 500-record scan cap. It filters locally across every page.
`query` matches names case-insensitively; date bounds are inclusive UTC calendar dates
(`YYYY-MM-DD`) on `created_at`. Timestamps without a timezone are interpreted as UTC, as in the
official MCP. Pagination is not a snapshot: changes to your library during an export can move
records between pages. Duplicate IDs are skipped, and repeated pages raise an error.

Download audio without buffering the whole file:

```ts
const response = await client.recordings.downloadAudio(recordingId)
await Bun.write("recording.mp3", response)
```

Signed URLs expire (Plaud currently describes a 24-hour lifetime). Do not persist them as
permanent links; request the recording again. Cloud sync must be enabled. A recording can
exist before its audio, transcript or summary is ready. The connector reads existing data;
it does not edit, delete, upload, transcribe, or generate summaries.

## Refresh, cancellation and failures

Sixb refreshes credentials before expiry or after a rejected API token. Each request obtains a
current token from Sixb; an API 401 invalidates that token and is replayed at most once. Safe GET
requests retry transient failures up to twice. OAuth exchange and refresh POSTs are never
replayed automatically: an uncertain outcome requires reauthorization through Sixb.

All resource methods accept an optional `signal`. Connector shutdown also cancels requests.
Options, in addition to the required `clientId`:

- `timeoutMs`: request timeout, default 30 seconds.
- `minDelayMs`: spacing between API requests, default 0; use e.g. 1500 for bulk exports to reduce rate limiting.
- `maxRetries`: safe GET retries, default 2.
- `region`: optional `x-pld-region` routing header, matching Plaud's official client.
- `maxContentBytes`: maximum linked text block size, default 20 MiB; audio is streamed separately.
- `downloadHosts`: additional exact HTTPS content hostnames for other Plaud storage regions.

The observed Plaud S3 content host is trusted by default. Verify any additional host before
adding it. Downloads never carry the API bearer token or routing headers, and redirects are
rejected. `PlaudApiError` exposes the status and operation without credentials, signed URLs,
or response bodies.

## Verification

```bash
bun test ./connectors/plaud/tests/
```

Package tests use mocked HTTP responses; no Plaud account is required. Validate browser
authorization and real account access manually using the setup above.

References: [Plaud MCP](https://docs.plaud.ai/plaud-mcp-cli/mcp),
[OAuth server metadata](https://mcp.plaud.ai/.well-known/oauth-authorization-server),
[account API availability](https://support.plaud.ai/hc/en-us/articles/60726890231449-How-can-I-get-API-access-to-my-Plaud-data),
[API recording limits](https://support.plaud.ai/hc/en-us/articles/59291709269401-Why-doesn-t-the-Plaud-API-return-all-of-my-recordings).
