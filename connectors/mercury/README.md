# @sixb/connector-mercury

Typed Mercury API connector for Sixb. It covers accounts, transactions, custom expense
categories, merchants, Accounts Receivable customers and invoices, the organization record, and
Mercury's event stream and webhook endpoints. Resources are independent, so the remaining Mercury
surfaces can be added without growing a monolithic client.

## Register

Create an API token on the [API Tokens page](https://app.mercury.com/settings/tokens), then define
the connector in your project's `connectors/` directory:

```ts
import { mercury } from "@sixb/connector-mercury"
import { defineConnector } from "@sixb/core"

export const mercuryConnector = defineConnector(
  "mercury",
  mercury({
    accessToken: process.env.MERCURY_API_TOKEN!,
  })
)
```

`createSixb()` discovers the definition automatically. Resolve the typed client with:

```ts
const mc = await sixb.connector(mercuryConnector)
```

Mercury tokens carry their own `secret-token:` prefix — pass the token exactly as the dashboard
shows it. The connector sends it as Bearer auth. The token can also be an async resolver, which is
called for every attempt and so supports OAuth access-token rotation without recreating the
connector.

A read-only token is enough for every `list` and `get` in this connector. Writes need a read-write
token (which requires an IP whitelist) or a custom token scoped to what you actually call.

## Options

| Option | Description |
| --- | --- |
| `accessToken` | Required API token, OAuth access token, or async resolver. Sent as Bearer auth. |
| `baseUrl` | Defaults to `https://api.mercury.com/api/v1/`. |
| `timeoutMs` | Optional per-attempt timeout. |
| `minDelayMs` | Delay between request starts. Defaults to `0` — Mercury documents no rate limit. |
| `retry` | Method-aware transient-failure policy. Defaults to two retries for GET only. |
| `onEvent` | Handler for inbound webhook deliveries. Providing it registers the `events` route. |
| `webhookSecret` | Endpoint signing secret. Deliveries are rejected unless the signature verifies. |
| `webhookToleranceMs` | Maximum accepted signature age. Defaults to 5 minutes. |
| `webhooks` | Extra inbound webhooks to register alongside the built-in `events` route. |

Default retries cover network errors, `429`, and `5xx` responses for reads, and honor
`Retry-After`. Writes are never replayed: Mercury uses `POST` to edit categories, customers, and
invoices and `PATCH` for transaction metadata, so treating any write as idempotent could duplicate
or clobber data.

### Sandbox

Point `baseUrl` at the sandbox and use a token created inside the sandbox — production tokens do
not work there.

```ts
mercury({
  accessToken: process.env.MERCURY_SANDBOX_TOKEN!,
  baseUrl: "https://api-sandbox.mercury.com/api/v1/",
})
```

Webhooks are not available in the sandbox; use the Events API there instead.

## Pagination

Mercury uses two styles, and the connector exposes both faithfully.

Most collections are **cursor-paginated**: the cursor is a resource id, `limit` accepts 1 to 1000
(defaulting to 1000 upstream), and each page reports `page.nextPage`. `listAll*` follows that
cursor and stops when it is absent.

```ts
for await (const txn of mc.transactions.listAll({ postedStart: "2026-07-01", order: "desc" })) {
  // Map the upstream transaction into a dataset or object.
}
```

The first request uses your options verbatim, so filters, `start_at`, and `end_before` all apply.
Later requests replace those cursors with `start_after`, because following `nextPage` is
forward-only. `start_after` and `end_before` are mutually exclusive, and `start_at` excludes both;
all three are enforced before a request goes out.

`GET /account/{id}/transactions` is the one **offset-paginated** endpoint. It reports `total`
instead of a cursor, and `listAllForAccount` pages by offset until it reaches that total.

## Accounts

| Client method | Mercury endpoint |
| --- | --- |
| `mc.accounts.list(options?)` | `GET /accounts` |
| `mc.accounts.listAll(options?)` | Cursor iterator over `GET /accounts` |

```ts
const { accounts } = await mc.accounts.list()
const checking = accounts.find((account) => account.kind === "checking")
```

## Transactions

| Client method | Mercury endpoint |
| --- | --- |
| `mc.transactions.list(options?)` | `GET /transactions` |
| `mc.transactions.listAll(options?)` | Cursor iterator over `GET /transactions` |
| `mc.transactions.get(id)` | `GET /transaction/{id}` |
| `mc.transactions.update(id, input)` | `PATCH /transaction/{id}` |
| `mc.transactions.listForAccount(accountId, options?)` | `GET /account/{accountId}/transactions` |
| `mc.transactions.listAllForAccount(accountId, options?)` | Offset iterator over account transactions |
| `mc.transactions.getForAccount(accountId, id)` | `GET /account/{accountId}/transaction/{id}` |

List filters that accept several values are repeated on the wire, as Mercury requires:

```ts
const page = await mc.transactions.list({
  status: ["pending", "sent"],
  accountId: ["acct-1", "acct-2"],
  postedStart: "2026-07-01",
  limit: 500,
})
```

`update` only touches transaction metadata — the note and the custom category. It sends just the
fields you pass, since Mercury treats an omitted field as "leave unchanged" and an explicit `null`
as "clear":

```ts
await mc.transactions.update(txn.id, { note: "Team lunch", categoryId: category.id })
await mc.transactions.update(txn.id, { categoryId: null }) // clears the category, keeps the note
```

Amounts are decimal numbers in the account currency, negative for debits. One exception:
`merchant.amount` is an integer in the merchant currency's smallest unit, so scale it using
`merchant.currency` (most currencies divide by 100, JPY by 1, and BHD, KWD, and OMR by 1000).

## Categories

Mercury has two category concepts and a transaction carries both:

- **Custom expense categories** — the organization's own vocabulary, managed through this resource
  and exposed on a transaction as `categoryData`.
- **Merchant type** — Mercury's fixed vocabulary, typed as `MercuryMerchantCategory` and exposed
  as `mercuryCategory`. It is assigned by Mercury and read-only, but you can filter on it.

| Client method | Mercury endpoint |
| --- | --- |
| `mc.categories.list(options?)` | `GET /categories` |
| `mc.categories.listAll(options?)` | Cursor iterator over `GET /categories` |
| `mc.categories.create(input)` | `POST /categories` |
| `mc.categories.update(id, input)` | `POST /categories/{id}` |
| `mc.categories.delete(id)` | `DELETE /categories/{id}` |

```ts
const category = await mc.categories.create({
  name: "Business Travel",
  visibleForReimbursements: true,
  visibleForCardSpend: true,
  visibleForOther: false,
})
```

The three `visibleFor*` flags decide which transaction kinds the category can be applied to; all
of them are required on create and each is optional on update.

## Merchants

| Client method | Mercury endpoint |
| --- | --- |
| `mc.merchants.list(options?)` | `GET /merchants` |
| `mc.merchants.listAll(options?)` | Cursor iterator over `GET /merchants` |

Priority merchants usable in spend controls such as card merchant locking. Supports a
case-insensitive `search` by name. Note the payload nests them under `data`, not `merchants`.

## Customers

Accounts Receivable customers — the parties invoices are billed to.

| Client method | Mercury endpoint |
| --- | --- |
| `mc.customers.list(options?)` | `GET /ar/customers` |
| `mc.customers.listAll(options?)` | Cursor iterator over `GET /ar/customers` |
| `mc.customers.get(id)` | `GET /ar/customers/{id}` |
| `mc.customers.create(input)` | `POST /ar/customers` |
| `mc.customers.update(id, input)` | `POST /ar/customers/{id}` |
| `mc.customers.delete(id)` | `DELETE /ar/customers/{id}` |

```ts
const customer = await mc.customers.create({
  name: "Globex",
  email: "ap@globex.example",
  address: {
    address1: "500 Terry A Francois Blvd",
    city: "San Francisco",
    region: "CA",
    postalCode: "94158",
    country: "US",
  },
})
```

## Invoices

| Client method | Mercury endpoint |
| --- | --- |
| `mc.invoices.list(options?)` | `GET /ar/invoices` |
| `mc.invoices.listAll(options?)` | Cursor iterator over `GET /ar/invoices` |
| `mc.invoices.get(id)` | `GET /ar/invoices/{id}` |
| `mc.invoices.create(input)` | `POST /ar/invoices` |
| `mc.invoices.update(id, input)` | `POST /ar/invoices/{id}` |
| `mc.invoices.cancel(id)` | `POST /ar/invoices/{id}/cancel` |

`destinationAccountId` must be a checking or savings account, and creating an invoice emails it to
the payer immediately unless you pass `sendEmailOption: "DontSend"`.

```ts
const invoice = await mc.invoices.create({
  customerId: customer.id,
  destinationAccountId: checking.id,
  invoiceDate: "2026-07-10",
  dueDate: "2026-08-10",
  lineItems: [{ name: "Implementation", unitPrice: 950.0, quantity: 3 }],
  ccEmails: [],
  creditCardEnabled: false,
  achDebitEnabled: true,
  useRealAccountNumber: false,
  sendEmailOption: "DontSend",
})
```

`update` replaces rather than patches — Mercury requires the invoice number, dates, line items, cc
list, and payment flags on every call, so read the invoice first and spread it if you only mean to
change one field. `customerId` and `destinationAccountId` cannot be changed after creation.

```ts
const current = await mc.invoices.get(invoice.id)
await mc.invoices.update(invoice.id, { ...current, dueDate: "2026-08-24" })
```

## Organization

| Client method | Mercury endpoint |
| --- | --- |
| `mc.organization.get()` | `GET /organization` |

Returns the organization the token belongs to, including its EIN, legal business name, DBAs, and
subscription tier. The connector unwraps Mercury's `organization` envelope and hands back the
record.

## Change tracking

Mercury offers two ways to observe changes, and both deliver the same event shape — a JSON Merge
Patch ([RFC 7396](https://datatracker.ietf.org/doc/html/rfc7396)) in `mergePatch` with the prior
values in `previousValues`. One handler can serve both paths.

### Events API (polling)

| Client method | Mercury endpoint |
| --- | --- |
| `mc.events.list(options?)` | `GET /events` |
| `mc.events.listAll(options?)` | Cursor iterator over `GET /events` |
| `mc.events.get(id)` | `GET /events/{id}` |

Store the last event id you processed and resume from it — no inbound HTTP surface required, which
also makes this the option that works in the sandbox.

```ts
for await (const event of mc.events.listAll({ start_after: lastEventId })) {
  if (event.resourceType === "transaction" && event.changedPaths.includes("status")) {
    const txn = await mc.transactions.get(event.resourceId)
    // Apply the change.
  }
  lastEventId = event.id
}
```

### Webhooks (push)

Pass `onEvent` to register an inbound route, and `webhookSecret` so deliveries are verified:

```ts
export const mercuryConnector = defineConnector(
  "mercury",
  mercury({
    accessToken: process.env.MERCURY_API_TOKEN!,
    webhookSecret: process.env.MERCURY_WEBHOOK_SECRET!,
    onEvent: async ({ event, logger }) => {
      logger.info(`[Mercury] ${event.resourceType} ${event.operationType}`, event.changedPaths)
    },
  })
)
```

The route verifies the `Mercury-Signature` HMAC-SHA256 over `<timestamp>.<raw body>`, rejects
timestamps older than the tolerance to block replays, reports the event id as the idempotency key
so at-least-once deliveries are de-duplicated, and responds `200`. Verification is skipped when no
`webhookSecret` is set, which is only appropriate in local development.

Register the endpoint URL with Mercury through the management resource. `secret` comes back on
create and never again, so store it then:

| Client method | Mercury endpoint |
| --- | --- |
| `mc.webhookEndpoints.list(options?)` | `GET /webhooks` |
| `mc.webhookEndpoints.listAll(options?)` | Cursor iterator over `GET /webhooks` |
| `mc.webhookEndpoints.get(id)` | `GET /webhooks/{id}` |
| `mc.webhookEndpoints.create(input)` | `POST /webhooks` |
| `mc.webhookEndpoints.update(id, input)` | `POST /webhooks/{id}` |
| `mc.webhookEndpoints.verify(id, input?)` | `POST /webhooks/{id}/verify` |
| `mc.webhookEndpoints.delete(id)` | `DELETE /webhooks/{id}` |

```ts
const endpoint = await mc.webhookEndpoints.create({
  url: "https://app.example/api/webhooks/mercury/events",
  eventTypes: ["transaction.created", "transaction.updated"],
  filterPaths: ["transaction.status", "transaction.postedAt"],
})
// endpoint.secret is only present here — persist it as MERCURY_WEBHOOK_SECRET.

await mc.webhookEndpoints.verify(endpoint.id)
```

Mercury disables an endpoint after repeated delivery failures; reactivate it with
`update(id, { status: "active" })`.

## Errors

Non-successful responses throw `MercuryApiError` with the status, parsed response body, response
headers, `retryAfterMs`, and request identifier when Mercury provides one.

```ts
import { MercuryApiError } from "@sixb/connector-mercury"

try {
  await mc.transactions.get(id)
} catch (error) {
  if (error instanceof MercuryApiError) {
    console.error(error.status, error.responseBody, error.requestId)
  }
}
```

## Official documentation

- [Getting started and authentication](https://docs.mercury.com/docs/getting-started)
- [API token security policies](https://docs.mercury.com/docs/api-token-security-policies)
- [Sandbox](https://docs.mercury.com/docs/using-mercury-sandbox)
- [Accounts](https://docs.mercury.com/reference/getaccounts)
- [Transactions](https://docs.mercury.com/reference/listtransactions)
- [Categories](https://docs.mercury.com/reference/listcategories)
- [Accounts Receivable](https://docs.mercury.com/reference/accounts_receivable)
- [Events](https://docs.mercury.com/reference/events)
- [Webhooks](https://docs.mercury.com/reference/webhooks)

## Not covered yet

Recipients and their invites, send-money and internal transfers, send-money approval requests,
treasury, statements and PDF downloads, cards, credit accounts, users, SAFEs, attachment uploads,
and the OAuth2 authorization flow are intentionally deferred. The shared HTTP, retry, error,
validation, and pagination layers are ready for those resource modules; statements, invoice PDFs,
and attachment uploads will additionally need binary response and multipart request handling.
