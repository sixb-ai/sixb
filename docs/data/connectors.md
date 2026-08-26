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

## Define an OAuth connector

For OAuth, Sixb owns state, PKCE, encrypted credentials, refresh coordination, and account
selection. The adapter owns the provider protocol and the client exposed to application code.

```ts
import { defineConnector } from "@sixb/core"

export const socialConnector = defineConnector("social", {
  type: "social",
  authentication: {
    type: "oauth2",
    authorizationUrl(context, { state, codeChallenge, codeChallengeMethod }) {
      const url = new URL("https://social.example/oauth/authorize")
      url.searchParams.set("redirect_uri", context.redirectUri)
      url.searchParams.set("state", state)
      url.searchParams.set("code_challenge", codeChallenge)
      url.searchParams.set("code_challenge_method", codeChallengeMethod)
      return url
    },
    exchangeCode(context, input) {
      return exchangeSocialCode({
        ...input,
        redirectUri: context.redirectUri,
        signal: context.signal,
      })
    },
    refresh(context, credentials) {
      return refreshSocialToken(credentials, { signal: context.signal })
    },
    revoke(context, credentials) {
      return revokeSocialGrant(credentials, { signal: context.signal })
    },
  },
  discoverAccounts(context, credentials) {
    return listSocialAccounts(credentials, { signal: context.signal })
  },
  connect({ account, tokenSource, signal }) {
    return {
      async request(path: string) {
        const token = await tokenSource.get()
        const response = await fetch(`https://social.example/accounts/${account.id}/${path}`, {
          headers: { authorization: `${token.tokenType ?? "Bearer"} ${token.accessToken}` },
          signal,
        })
        if (response.status === 401) token.invalidate()
        return response
      },
    }
  },
})
```

Trusted primitive executions resolve one stable project connection by its application-defined
slot:

```ts
const social = await sixb.connector(socialConnector, {
  owner: { type: "project" },
  slot: "organic-marketing",
})
```

Each returned token invalidates only its own credential revision, so a late `401` cannot refresh a
newer token. Provider failures that affect a grant can be classified explicitly:

| `ConnectorOAuthError` kind | Use when |
| --- | --- |
| `retryable` | The adapter guarantees that the provider made no external change. |
| `terminal` | The provider definitively rejected the grant or credential. |
| `ambiguous` | The provider may have changed state, or the adapter cannot prove otherwise. |

Unclassified errors are treated as `ambiguous` and fail closed. Throw, for example,
`new ConnectorOAuthError("retryable", "Social provider is unavailable", { cause })` only when
retrying the unchanged operation is safe. `revoke()` must be idempotent: an already revoked or
invalid grant resolves successfully.

Managing an OAuth connection requires an authenticated request whose role grants the connector:

```ts
can.manage(socialConnector)
// or: can.manage(every.connector())
```

Syncs automatically read every connected account for an OAuth connector. The handler receives
non-secret connection metadata through `context.connection`; no connection selector is required
in the Sync definition. See [OAuth connector fan-out](./syncs.md#oauth-connector-fan-out).

> **Current scope.** OAuth-backed webhook routing remains rejected until its connection admission
> contract is defined.

## Protect OAuth credentials

When at least one OAuth connector uses durable connector storage, Sixb encrypts its tokens at rest.
`SqliteStorage` and `PostgresStorage` provide that durable storage automatically. Provide the
canonical base64url encoding of 32 random bytes through `createSixb()`:

```ts
const connectorEncryptionKey = process.env.SIXB_CONNECTOR_ENCRYPTION_KEY

if (!connectorEncryptionKey) {
  throw new Error("[SixbConfig] SIXB_CONNECTOR_ENCRYPTION_KEY is required")
}

export const sixb = createSixb({
  storage: new PostgresStorage({ connectionString: process.env.DATABASE_URL }),
  connectorConnections: { encryptionKey: connectorEncryptionKey },
})
```

The storage provider owns persistence; `connectorConnections` only configures credential
protection. Static connectors still require neither.

Generate the value once, then store it in the deployment's secret manager:

```bash
bun -e 'import { randomBytes } from "node:crypto"; console.log(randomBytes(32).toString("base64url"))'
```

Every process sharing the same connector database must receive the same key. Do not commit,
replace, or lose it: existing OAuth credentials would become unreadable.

Static connectors do not need this setting. It can also be omitted with ephemeral connector
storage, where both the stored credentials and Sixb's process-local protection disappear on
restart.

## Connect an OAuth account from an app

Sixb owns the OAuth callback, state, PKCE exchange, durable run, and lifecycle transitions. The
application keeps control of its interface through one headless hook:

```tsx
import { useConnectorConnection } from "@sixb/client/hooks"

export function SocialConnection() {
  const social = useConnectorConnection({
    connectorId: "social",
    slot: "organic-marketing",
  })

  return (
    <>
      <button onClick={social.connect} disabled={!social.canConnect}>
        {social.connection?.account.label ?? "Connect social account"}
      </button>

      {social.status === "selecting_account" &&
        social.accounts.map((account) => (
          <button key={account.id} onClick={() => social.selectAccount(account.id)}>
            {account.label}
          </button>
        ))}
    </>
  )
}
```

`slot` is the stable application role filled by the connection, not the provider account id. For
example, `organic-marketing`, `customer-support`, or `brand-france` can each resolve a different
account later through `sixb.connector(...)`. Project ownership is implicit in V1.

Register this server-owned callback URL with the OAuth provider:

```text
https://<sixb-api-origin>/auth/connectors/callback
```

By default, OAuth returns to the current page while preserving unrelated query parameters and the
URL hash. Keep the hook mounted there: it resumes the run from the non-secret callback identity and
exposes `selecting_account` when the application must present provider accounts. The hook also
exposes `disconnect()`, `revoke()`, and `needs_reauthorization`; Sixb imposes the protocol, not its
visual representation.

Selecting an account for an occupied slot returns a replacement conflict. Detect it with
`isConnectorReplacementRequired(connection.error?.cause)`, ask for confirmation in the
application, then retry with `selectAccount(accountId, { replace: true })`.

To expose another account from the same OAuth grant, start a selection run from an existing
connection. The provider authorization is not repeated:

```tsx
import { useAddConnectorConnection } from "@sixb/client/hooks"

const addAccount = useAddConnectorConnection({
  connectorId: "social",
  fromConnectionId: socialConnection.id,
  slot: "paid-marketing",
})

addAccount.mutate()
```

The returned run is already waiting for `account_selection`. Use `useConnectorConnectionRun` and
`useSelectConnectorAccount` when building this advanced multi-slot flow.

A connection run records the interactive execution: `waiting`, `running`, then a terminal status.
Its terminal record is secret-free and retained without automatic cleanup in V1.

| Client operation | Effect |
| --- | --- |
| `listConnectorConnections()` | Lists known connections and their current lifecycle status. |
| `addConnectorConnection()` | Selects another account through an existing OAuth grant. |
| `disconnectConnectorConnection()` | Disconnects one account; the last usage also schedules grant revocation. |
| `reauthorizeConnectorConnection()` | Starts a new OAuth run for an existing grant. |
| `revokeConnectorConnection()` | Revokes the grant and disconnects every account sharing it. |

Management routes require a browser session, CSRF protection, and `can.manage(connector)`.
Authorization ids and OAuth credentials are never exposed.

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
| `@sixb/connector-stripe` | `stripe(...)` | Stripe customers, subscriptions, invoices, refunds, events | `stripeEventsWebhook` |
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
