# Connectors

A connector is Sixb's reusable connection to an external system. You give it config once, and
[syncs](./syncs.md), workflow steps, and app code resolve the same connected client by name.

Reach for a connector when your project needs to read from an external system, call a third-party
API, or share one database/API client across several places — while keeping credentials and
connection setup out of the code that uses them. A connector does not describe data shape: use a
[dataset](./datasets.md) for tables and an [ontology](../ontology/overview.md) for objects.

## Define a connector

`defineConnector(id, adapter)` returns an inert `ConnectorDefinition`. It does not open a
connection — the runtime does that on first use. An adapter needs a `type` and a `connect`, and may
add `disconnect` for cleanup.

The Acme platform pulls customers, invoices, employees, and departments from a mock ERP. The
connector returns a small typed client tailored to the calls the syncs make.

File: `connectors/acme-erp.ts`

```ts
import { defineConnector } from "@sixb/core"
import { createAcmeErpClient } from "../lib/acme-erp"

export const acmeErpConnector = defineConnector("acme-erp", {
  type: "acme-erp",
  connect() {
    return createAcmeErpClient()
  },
})
```

That is the whole connector. Sixb now has one named place to get an ERP client, and
`createAcmeErpClient()` decides which methods exist. Its `AcmeErpClient` exposes one `list*` call
per ERP table — the syncs use this subset:

```ts
export interface AcmeErpClient {
  listCustomers(): Promise<readonly ErpCustomerRow[]>
  listInvoices(): Promise<readonly ErpInvoiceRow[]>
  listEmployees(): Promise<readonly ErpEmployeeRow[]>
  listDepartments(): Promise<readonly ErpDepartmentRow[]>
  // ...plus listProjects, listTasks, and other tables
}
```

A custom connector can return any client shape. Keep it small and tailored to the calls your
project actually makes.

## Use it from a sync

Syncs receive the connected client from `.from(...)`. This keeps the sync focused on one job: read
rows and write them into a dataset.

```ts
import { defineSync } from "@sixb/core"
import { acmeErpConnector } from "../connectors/acme-erp"
import { erpInvoicesDataset } from "../datasets/erp"

export const syncErpInvoices = defineSync("sync-erp-invoices")
  .from(acmeErpConnector)
  .read((client) => client.listInvoices())
  .intoDataset(erpInvoicesDataset)
```

See [Syncs](./syncs.md) for scheduling and chaining. To map the raw rows into `Invoice` and
`Customer` objects, see [Projections](./projections.md).

## Use a connector directly

You can also resolve a connector straight from the runtime — useful in workflow steps or scripts.

```ts
import { acmeErpConnector } from "../connectors/acme-erp"
import { sixb } from "../sixb.config"

export async function loadInvoices() {
  const runtime = await sixb
  const client = await runtime.connector(acmeErpConnector)

  return client.listInvoices()
}
```

The first call opens the connection. Later calls reuse the same client for that runtime.

> **Footgun: pass the registered instance.** `runtime.connector(...)` rejects a definition that is
> not the exact instance registered with the runtime. A freshly constructed `defineConnector(...)`
> with the same id throws `Connector '<id>' is not the registered definition instance.` Always
> import and pass the exported connector, not a local copy.

## ConnectorContext

`connect` receives a `ConnectorContext` so adapters can scope logs, build cache keys, or cancel
long-running startup work.

| Field | Type | Notes |
| --- | --- | --- |
| `projectId` | `string` | The runtime's project id. |
| `connectorId` | `string` | This connector's id. |
| `signal` | `AbortSignal` | Aborted when the runtime disconnects the connector. |

```ts
export const acmeErpConnector = defineConnector("acme-erp", {
  type: "acme-erp",
  connect(context) {
    // Forward context.signal to any client that supports cancellation.
    return createAcmeErpClient()
  },
})
```

Add `disconnect(client)` to close handles when the runtime tears the connector down. The mock ERP
client has nothing to clean up — this shows the hook for a client that does:

```ts
export const acmeErpConnector = defineConnector("acme-erp", {
  type: "acme-erp",
  connect() {
    return createAcmeErpClient()
  },
  disconnect(client) {
    return client.close()
  },
})
```

## Built-in adapters

When a system fits a common protocol, use a packaged adapter instead of writing `connect` yourself.

| Package | Factory | `type` | Connected client |
| --- | --- | --- | --- |
| `@sixb/connector-sql` | `sql(connection)` | `"sql"` | Bun `SQL` (Postgres, MySQL, SQLite) |
| `@sixb/connector-rest` | `rest(options)` | `"rest"` | `RestClient` (`request`/`get`/`post`) |
| `@sixb/connector-sftp` | `sftp(connection, options?)` | `"sftp"` | `SftpClient` (`list`/`open`/`read`/`write`/…) |
| `@sixb/connector-imap` | `imap(connection)` | `"imap"` | Read-only `ImapClient` (mailboxes/messages/MIME parts) |

If the ERP were a real Postgres database, the connector would be one line:

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

### Hosted-service connectors

Sixb also ships typed connectors for common SaaS and platform APIs. Each exports a factory you pass
to `defineConnector`, and most ship a matching webhook helper for the [Webhooks](#webhooks) below.

| Package | Factory | Connects to | Webhook helper |
| --- | --- | --- | --- |
| `@sixb/connector-exa` | `exa(...)` | Exa web search and page contents | — |
| `@sixb/connector-github` | `github(...)` | GitHub REST API | `githubEventsWebhook` |
| `@sixb/connector-google` | `google(...)` | Google APIs (Drive, Calendar, Gmail, Analytics) | — |
| `@sixb/connector-google` | `googleAds(...)` | Google Ads manager-account reporting | — |
| `@sixb/connector-meta` | `meta(...)` | Meta Graph API (Facebook/Instagram) | — |
| `@sixb/connector-pipedrive` | `pipedrive(...)` | Pipedrive CRM | `pipedriveEventsWebhook` |
| `@sixb/connector-teamleader` | `teamleader(...)` | Teamleader CRM, invoicing, quotations | `defineTeamleaderWebhook` |
| `@sixb/connector-pandadoc` | `pandadoc(...)` | PandaDoc documents and e-signatures | `pandaDocEventsWebhook` |
| `@sixb/connector-companycam` | `companycam(...)` | CompanyCam jobsite photos | `companyCamEventsWebhook` |
| `@sixb/connector-pennylane` | `pennylane(...)` | Pennylane quotes, products, customers | — |
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
exports bounded [`web_search` and `web_fetch` tools](../agents/tools-and-gateway.md#exa-web-tools).

## Webhooks

A connector adapter may declare inbound `webhooks` alongside `connect`. Define them with
`defineWebhook(...)` so the server routes incoming requests to the connector. Pass a schema to
`.json(...)` to validate the payload and give the handler a typed `body`. The ERP posts invoice
lifecycle events:

```ts
import { defineConnector, defineWebhook } from "@sixb/core"
import { createAcmeErpClient } from "../lib/acme-erp"

export const acmeErpConnector = defineConnector("acme-erp", {
  type: "acme-erp",
  webhooks: [
    defineWebhook("invoice-events")
      .post()
      .json({ parse: parseInvoiceWebhookEvent })
      .verify(({ request }) => {
        if (request.headers.get("x-acme-signature") !== process.env.ACME_WEBHOOK_SECRET) {
          throw new Error("[AcmeErp] Invalid webhook signature")
        }
      })
      .idempotencyKey(({ request, body }) => request.headers.get("x-acme-delivery") ?? body.deliveryId)
      .handle(({ body }) => {
        console.log(`[AcmeErp] Received ${body.type} for ${body.invoiceId}`)
      }),
  ],
  connect() {
    return createAcmeErpClient()
  },
})
```

`parseInvoiceWebhookEvent` is a plain function that validates `unknown` and returns the typed event
(it gives `body` its `type`, `invoiceId`, and `deliveryId` fields). Bare `.json()` is also valid
when you do not need a typed body. Verification and idempotency resolution run before admission; only the handler receives an execution-bound `sixb` and run logger.

## Discovery and registration

Put connector definitions in `connectors/` and export them. `createSixb()` discovers them
automatically — see [Project structure](../fundamentals/project-structure.md).

```txt
your-project/
  connectors/
    acme-erp.ts
  datasets/
    erp.ts
  syncs/
    erp.ts
  sixb.config.ts
```

You can also register connectors explicitly:

```ts
import { createSixb } from "@sixb/core"
import { acmeErpConnector } from "./connectors/acme-erp"

export const sixb = createSixb({
  connectors: [acmeErpConnector],
})
```

Connector ids must be unique within a runtime — a duplicate id throws at registration.

## Core principles

- Start with a packaged adapter; write a custom `connect` only when the system needs special behavior.
- Keep one connector focused on one external system.
- Keep credentials and connection setup inside the connector.
- Keep data mapping in [syncs](./syncs.md), [pipelines](./pipelines.md), or [projections](./projections.md).

## Where connectors fit

| Need | Use |
| --- | --- |
| Talk to an external system | Connector |
| Store rows from that system | [Dataset](./datasets.md) |
| Move external data into Sixb | [Sync](./syncs.md) |
| Transform rows into cleaner rows | [Pipeline](./pipelines.md) |
| Turn rows into objects for apps | [Projection](./projections.md) |
