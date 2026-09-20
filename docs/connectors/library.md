# Connector library

Search the available adapters by platform, protocol, or use case. Each card opens its package reference.

<div data-connector-library></div>

## Protocol adapters

When a system fits a common protocol, use a packaged adapter instead of writing `connect` yourself.

| Package | Factory | `type` | Connected client |
| --- | --- | --- | --- |
| `@sixb/connector-sql` | `sql(connection)` | `"sql"` | Bun `SQL` (Postgres, MySQL, SQLite) |
| `@sixb/connector-rest` | `rest(options)` | `"rest"` | `RestClient` (`request`/`get`/`post`) |
| `@sixb/connector-sftp` | `sftp(connection, options?)` | `"sftp"` | `SftpClient` (`list`/`open`/`read`/`write`/…) |
| `@sixb/connector-imap` | `imap(connection)` | `"imap"` | Read-only `ImapClient` (mailboxes/messages/MIME parts) |

For a PostgreSQL database:

```ts
import { defineConnector } from "@sixb/core"
import { sql } from "@sixb/connector-sql"

export const acmeErpConnector = defineConnector("acme-erp", sql(process.env.DATABASE_URL!))
```

```ts
export const syncErpInvoices = defineSync("sync-erp-invoices")
  .from(acmeErpConnector)
  .read((db) => db`select * from invoices`)
  .intoDataset(erpInvoicesDataset)
```

### `rest(options)`

Pass a `baseUrl` and optional auth, timeout, rate-limit, and retry settings.

```ts
import { rest } from "@sixb/connector-rest"

rest({
  baseUrl: "https://erp.acme.internal",
  headers: { authorization: `Bearer ${process.env.ACME_ERP_TOKEN}` },
})
```

| Option | Type | Notes |
| --- | --- | --- |
| `baseUrl` | `string` | Required. Prepended to request paths. |
| `headers` | `HeadersInit` or `(ctx) => HeadersInit` | Static or per-request resolver (sync or async). |
| `timeoutMs` | `number` | Per-request timeout. |
| `minDelayMs` | `number` | Minimum delay between requests (rate limiting). |
| `onUnauthorized` | `(ctx) => void \| Promise<void>` | Hook to refresh credentials on a 401. |
| `retry` | `RestRetryPolicy` | `{ maxRetries, shouldRetry?, delayMs? }`. |

### `sql(connection)` and `sftp(connection, options?)`

`sql` takes a connection string, a `URL`, or a Bun `SQL.Options` object; the connected client is the
native Bun SQL client, shared across Postgres, MySQL, and SQLite. `sftp` takes an ssh2
`ConnectConfig`; its `SftpClient` exposes `list`, `stat`, `exists`, `ensureDir`, `open`, `read`,
`write`, `rename`, `delete`, `mkdir`, and `rmdir`. `open(path, { signal? })` returns a backpressured
`ReadableStream<Uint8Array>` for large files; `read(path)` remains the buffered convenience for
small files. Set `options.readAheadRequests` to an integer from `1` to `64` to keep that many
ordered reads in flight per open stream; it defaults to sequential reads (`1`). Both adapters close
their client on `disconnect`.

<details>
<summary>Platform factories and webhook helpers</summary>

### Hosted-service connectors

Sixb also ships typed connectors for common SaaS and platform APIs. Each exports a factory you pass
to `defineConnector`, and some include a helper for [webhook deliveries](webhooks.md).

| Package | Factory | Connects to | Webhook helper |
| --- | --- | --- | --- |
| `@sixb/connector-exa` | `exa(...)` | Exa web search and page contents | — |
| `@sixb/connector-github` | `github(...)` | GitHub REST API | `githubEventsWebhook` |
| `@sixb/connector-google` | `google(...)` | Google APIs (Drive, Calendar, Gmail, Analytics) | — |
| `@sixb/connector-google` | `googleAds(...)` | Google Ads manager-account reporting | — |
| `@sixb/connector-linkedin` | `linkedin(...)` | LinkedIn advertising and organic Page management | — |
| `@sixb/connector-meta` | `meta(...)` | Meta Graph API (Facebook/Instagram) | — |
| `@sixb/connector-microsoft` | `microsoft(...)` | Microsoft Graph (SharePoint files, Outlook mail, calendars, attachments, delta sync and subscriptions) | Built-in `onEvent` receiver |
| `@sixb/connector-notion` | `notion(...)` | Notion pages, properties, and Markdown | — |
| `@sixb/connector-pipedrive` | `pipedrive(...)` | Pipedrive CRM | `pipedriveEventsWebhook` |
| `@sixb/connector-stripe` | `stripe(...)` | Stripe customers, subscriptions, invoices and line items, invoice payments, payment intents, charges, refunds, events | `stripeEventsWebhook` |
| `@sixb/connector-teamleader` | `teamleader(...)` | Teamleader CRM, invoicing, quotations | `defineTeamleaderWebhook` |
| `@sixb/connector-tiktok` | `tiktok(...)` | TikTok Display, Business Organic, and Ads reporting | — |
| `@sixb/connector-pandadoc` | `pandadoc(...)` | PandaDoc documents and e-signatures | `pandaDocEventsWebhook` |
| `@sixb/connector-companycam` | `companycam(...)` | CompanyCam jobsite photos | `companyCamEventsWebhook` |
| `@sixb/connector-pennylane` | `pennylane(...)` | Pennylane quotes, products, customers | — |
| `@sixb/connector-quickbooks` | `quickbooks(...)` | QuickBooks Online accounting reads/writes, receipt sending, and CDC (managed OAuth) | Verified CloudEvents |
| `@sixb/connector-mercury` | `mercury(...)` | Mercury banking, transactions, invoicing | `mercuryEventsWebhook` |
| `@sixb/connector-ace-iot` | `aceIot(...)` | ACE IoT sites, BACnet points, gateways, timeseries | — |
| `@sixb/connector-unipile` | `unipile(...)` | Unipile messaging and LinkedIn outreach | `unipileEventsWebhook` |

The pattern is the same as any adapter — `defineConnector(id, factory(options))`, then resolve it by
name in syncs and app code:

```ts
import { defineConnector } from "@sixb/core"
import { github } from "@sixb/connector-github"

export const githubConnector = defineConnector("github", github({ token: process.env.GITHUB_TOKEN! }))
```

Each factory's connected client and full options are documented in its package README. Exa also
exports bounded [`web_search` and `web_fetch` tools](../models/tools-and-authorization.md#exa-web-tools).

</details>
