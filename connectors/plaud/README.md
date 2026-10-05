# @sixb/connector-plaud

Read your Plaud recordings, complete transcripts, notes, and original audio from Sixb.
The connector calls the same HTTP endpoints as the official Plaud MCP/CLI; no MCP process or
language model is needed at runtime.

Plaud does **not** offer a public, general-purpose account API. This integration follows the
public native client shipped in `@plaud-ai/mcp` **0.3.13**, inspected on **2026-10-05**. These
endpoints and client registration can change without compatibility guarantees. It is intended
for your own account, not a substitute for a registered multi-user Plaud application.

## Authenticate once

Create a local script and run it with Bun:

```ts
import { loginPlaud } from "@sixb/connector-plaud/auth"

await loginPlaud({
  onAuthorizationUrl(url) {
    console.log(`Open this URL to authorize Plaud: ${url}`)
  },
})
```

Open the URL, sign into Plaud and approve access. The helper checks OAuth state, uses PKCE S256,
and receives the callback on `http://localhost:8199/auth/callback`. Keep port 8199 free. On a
remote machine, forward that port to the machine running the login script. It waits at most two
minutes. The connector never collects your Plaud password or launches a browser implicitly.

Credentials are stored at `~/.plaud/tokens-sixb.json`, outside your project, with mode `0600`.
Pass `tokenFile` to both `loginPlaud()` and `plaud()` to choose another location. A custom
`PlaudTokenStore` can use a secret manager instead; its `withLock` must serialize all users of
the same credentials across processes. Never put credentials in source control.

Already signed into the official MCP? You can explicitly use its existing token file:

```ts
import { homedir } from "node:os"
import { join } from "node:path"
import { plaud } from "@sixb/connector-plaud"

const adapter = plaud({ tokenFile: join(homedir(), ".plaud", "tokens-mcp.json") })
```

This reads **and updates** that file when a refresh is needed. Avoid simultaneous use by the
MCP/CLI: the official client does not participate in Sixb's file lock. Prefer a separate login
and the default `tokens-sixb.json` for an unattended integration. Do not copy a rotating refresh
token into independently managed stores.

## Define the connector

```ts
// connectors/plaud.ts
import { defineConnector } from "@sixb/core"
import { plaud } from "@sixb/connector-plaud"

export const recordings = defineConnector("plaud", plaud())
```

```ts
const client = await sixb.connector(recordings)

const account = await client.users.current()
const page = await client.recordings.list({ page: 1, pageSize: 100 })

for await (const recording of client.recordings.iterate()) {
  const transcript = await client.transcripts.get(recording.id)
  const notes = await client.notes.list(recording.id)
  // transcript.content is complete; transcript.segments preserves timestamps and speakers.
}
```

This is a personal-account adapter using local OAuth credentials. It does not use Sixb's
browser-based account selection UI or `connectorConnections` storage. Browser authorization
is a one-time setup operation; normal reads and token refresh work without a browser.

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

The connector refreshes tokens 60 seconds before their recorded expiry, or once after an API
401. It rereads the store for each request, coordinates concurrent refreshes, and saves rotated
tokens before returning them. Safe GET requests retry transient failures up to twice; token
exchange and refresh POSTs are never automatically replayed.

A lost refresh response, interrupted refresh, malformed token response, or failed token save
can leave the result uncertain. The persisted `refresh_pending` marker stops reuse of the old
refresh token. Run `loginPlaud()` again to recover. A 429 preserves the existing tokens for a
later retry. A crashed process can also leave `<tokenFile>.lock`: remove it **only after confirming
the owning process has stopped**, then reauthorize if the refresh was pending.

All methods accept an optional `signal`. Connector shutdown also cancels requests. Options:

- `timeoutMs`: request timeout, default 30 seconds.
- `minDelayMs`: spacing between API requests, default 0.
- `maxRetries`: safe GET retries, default 2.
- `region`: optional `x-pld-region` routing header, matching Plaud's official client.
- `maxContentBytes`: maximum linked text block size, default 20 MiB; audio is streamed separately.
- `downloadHosts`: additional exact HTTPS content hostnames for other Plaud storage regions.

The observed Plaud S3 content host is trusted by default. Verify any additional host before
adding it. Downloads never carry the API bearer token or routing headers, and redirects are
rejected. `PlaudApiError` exposes the status and operation without credentials, signed URLs,
or response bodies. `PlaudAuthError` identifies authorization/storage problems.

## Verification

```bash
bun test ./connectors/plaud/tests/
```

The package tests use mocked HTTP responses and temporary token stores; no Plaud account is
required. Validate browser authorization and real account access manually using the examples
above. Those checks may refresh and update the selected token file.

References: [Plaud MCP](https://docs.plaud.ai/plaud-mcp-cli/mcp),
[account API availability](https://support.plaud.ai/hc/en-us/articles/60726890231449-How-can-I-get-API-access-to-my-Plaud-data),
[API recording limits](https://support.plaud.ai/hc/en-us/articles/59291709269401-Why-doesn-t-the-Plaud-API-return-all-of-my-recordings).
