# @sixb/connector-pennylane

Typed Pennylane Company API v2 connector for Sixb. It covers the Quotes, Products, Customers, and
Ledger Accounts API surfaces and is structured around independent resources so other Pennylane
endpoints can be added without growing a monolithic client.

## Register

Create a Company API token with the scopes you need — `quotes`, `products`, `customers`, and
`ledger_accounts`, each in a `:readonly` (reads) or `:all` (writes) variant — then define the
connector in your project's `connectors/` directory:

```ts
import { pennylane } from "@sixb/connector-pennylane"
import { defineConnector } from "@sixb/core"

export const pennylaneConnector = defineConnector(
  "pennylane",
  pennylane({
    accessToken: process.env.PENNYLANE_API_TOKEN!,
  })
)
```

`createSixb()` discovers the definition automatically. Resolve the typed client with:

```ts
const pl = await sixb.connector(pennylaneConnector)
```

The access token can also be an async resolver. It is called for every attempt, which supports OAuth
access-token rotation without recreating the connector.

## Options

| Option | Description |
| --- | --- |
| `accessToken` | Required Company API token, OAuth access token, or async resolver. Sent as Bearer auth. |
| `baseUrl` | Defaults to `https://app.pennylane.com/api/external/v2/`. |
| `timeoutMs` | Optional per-attempt timeout. |
| `minDelayMs` | Delay between request starts. Defaults to 200ms to respect 25 requests per 5 seconds. |
| `retry` | Method-aware transient-failure policy. Defaults to two retries for GET only. |

The built-in scheduler also spaces concurrently initiated requests. Default retries cover network
errors, `429`, and `5xx` responses for reads and honor `Retry-After`. Writes are not replayed by
default: even `PUT /quotes/{id}` can create invoice lines, while creating some ledger accounts can
create related records, so treating every write as idempotent could duplicate data.

## Quotes API

| Client method | Pennylane endpoint |
| --- | --- |
| `pl.quotes.list(options?)` | `GET /quotes` |
| `pl.quotes.listAll(options?)` | Cursor iterator over `GET /quotes` |
| `pl.quotes.get(id)` | `GET /quotes/{id}` |
| `pl.quotes.listInvoiceLineSections(id, options?)` | `GET /quotes/{id}/invoice_line_sections` |
| `pl.quotes.listAllInvoiceLineSections(id, options?)` | Cursor iterator over quote sections |
| `pl.quotes.listInvoiceLines(id, options?)` | `GET /quotes/{id}/invoice_lines` |
| `pl.quotes.listAllInvoiceLines(id, options?)` | Cursor iterator over quote lines |
| `pl.quotes.listAppendices(id, options?)` | `GET /quotes/{id}/appendices` |
| `pl.quotes.listAllAppendices(id, options?)` | Cursor iterator over appendices |
| `pl.quotes.create(input)` | `POST /quotes` |
| `pl.quotes.uploadAppendix(id, input)` | `POST /quotes/{id}/appendices` |
| `pl.quotes.sendByEmail(id, input?)` | `POST /quotes/{id}/send_by_email` |
| `pl.quotes.update(id, input)` | `PUT /quotes/{id}` |
| `pl.quotes.updateStatus(id, input)` | `PUT /quotes/{id}/update_status` |

### List and filter

Filters are typed and serialized to Pennylane's required JSON query parameter:

```ts
const page = await pl.quotes.list({
  limit: 100,
  sort: "-id",
  filter: [
    { field: "customer_id", operator: "in", value: [42, 43] },
    { field: "status", operator: "not_eq", value: "denied" },
  ],
})
```

`listAll()` follows `has_more` and `next_cursor`. It repeats the original filters and sort on every
page, as required by Pennylane because cursors do not retain query state:

```ts
for await (const quote of pl.quotes.listAll({
  filter: [{ field: "status", operator: "eq", value: "accepted" }],
})) {
  // Map the upstream quote into a dataset or object.
}
```

### Create and update

Pennylane accepts either product-backed or custom quote lines. Decimal monetary values remain strings
where required by the API so the connector never introduces floating-point conversions.

```ts
const quote = await pl.quotes.create({
  date: "2026-07-10",
  deadline: "2026-08-10",
  customer_id: 42,
  external_reference: "CRM-2026-0042",
  invoice_lines: [
    {
      label: "Implementation",
      quantity: 3,
      raw_currency_unit_price: "950.00",
      unit: "day",
      vat_rate: "FR_200",
    },
  ],
})

await pl.quotes.update(quote.id, {
  invoice_lines: {
    update: [{ id: 123, quantity: 4 }],
    delete: [{ id: 124 }],
  },
})

await pl.quotes.updateStatus(quote.id, { status: "accepted" })
```

### Appendices and email

```ts
await pl.quotes.uploadAppendix(quote.id, {
  file: Bun.file("./terms.pdf"),
  filename: "terms.pdf",
})

await pl.quotes.sendByEmail(quote.id, {
  recipients: ["customer@example.com"],
})
```

Pennylane can return `409` from `sendByEmail` while the quote PDF is still being generated. The
connector surfaces that response and does not retry the POST automatically; retry the operation later
according to your workflow.

## Products API

| Client method | Pennylane endpoint |
| --- | --- |
| `pl.products.list(options?)` | `GET /products` |
| `pl.products.listAll(options?)` | Cursor iterator over `GET /products` |
| `pl.products.get(id)` | `GET /products/{id}` |
| `pl.products.create(input)` | `POST /products` |
| `pl.products.update(id, input)` | `PUT /products/{id}` |

Prices stay decimal strings so the connector never introduces floating-point rounding.

```ts
const page = await pl.products.list({
  sort: "-id",
  filter: [{ field: "label", operator: "in", value: ["Consulting", "Support"] }],
})

const product = await pl.products.create({
  label: "Consulting",
  price_before_tax: "950.00",
  vat_rate: "FR_200",
  unit: "day",
})
```

## Customers API

Customers are polymorphic. `list` and `get` return a `PennylaneCustomer` union discriminated by
`customer_type` (`"company"` or `"individual"`); writes map one-to-one to Pennylane's typed endpoints.

| Client method | Pennylane endpoint |
| --- | --- |
| `pl.customers.list(options?)` | `GET /customers` |
| `pl.customers.listAll(options?)` | Cursor iterator over `GET /customers` |
| `pl.customers.get(id)` | `GET /customers/{id}` |
| `pl.customers.createCompany(input)` | `POST /company_customers` |
| `pl.customers.createIndividual(input)` | `POST /individual_customers` |
| `pl.customers.updateCompany(id, input)` | `PUT /company_customers/{id}` |
| `pl.customers.updateIndividual(id, input)` | `PUT /individual_customers/{id}` |
| `pl.customers.listContacts(id, options?)` | `GET /customers/{id}/contacts` |
| `pl.customers.listAllContacts(id, options?)` | Cursor iterator over contacts |
| `pl.customers.listCategories(id, options?)` | `GET /customers/{id}/categories` |
| `pl.customers.listAllCategories(id, options?)` | Cursor iterator over categories |
| `pl.customers.categorize(id, categories)` | `PUT /customers/{id}/categories` |

```ts
for await (const customer of pl.customers.listAll({
  filter: [{ field: "customer_type", operator: "eq", value: "company" }],
})) {
  if (customer.customer_type === "company") {
    // customer.vat_number is available here after narrowing.
  }
}

await pl.customers.createIndividual({
  first_name: "Ada",
  last_name: "Lovelace",
  billing_address: {
    address: "2 avenue Foch",
    postal_code: "75116",
    city: "Paris",
    country_alpha2: "FR",
  },
})
```

Ledger accounts are referenced by account number when writing a customer (`ledger_account: { number }`)
but by id on products (`ledger_account_id`), mirroring the upstream API. `categorize` replaces the
customer's categories and returns the resulting list.

## Ledger Accounts API

| Client method | Pennylane endpoint |
| --- | --- |
| `pl.ledgerAccounts.list(options?)` | `GET /ledger_accounts` |
| `pl.ledgerAccounts.listAll(options?)` | Cursor iterator over `GET /ledger_accounts` |
| `pl.ledgerAccounts.get(id)` | `GET /ledger_accounts/{id}` |
| `pl.ledgerAccounts.create(input)` | `POST /ledger_accounts` |
| `pl.ledgerAccounts.update(id, input)` | `PUT /ledger_accounts/{id}` |

The list supports pages of up to 1,000 accounts, `id`/`-id` sorting, and typed filters for `id`,
`number`, and `enabled`. Pennylane documents `has_more` as nullable for this endpoint; `listAll()`
treats `null` as a terminal page while retaining the normal missing/repeated-cursor safeguards.

```ts
for await (const account of pl.ledgerAccounts.listAll({
  filter: [
    { field: "number", operator: "start_with", value: "706" },
    { field: "enabled", operator: "eq", value: true },
  ],
})) {
  // Ledger entry lines reference account.id, not the potentially non-unique account.number.
}

await pl.ledgerAccounts.create({
  number: "706100",
  label: "Consulting services",
  vat_rate: "FR_200",
  country_alpha2: "FR",
})

await pl.ledgerAccounts.update(42, {
  label: "Professional services",
  letterable: true,
})
```

Only `label` and `letterable` can be updated. Creating an account whose number begins with `401` can
also create a supplier; a number beginning with `411` can create a company customer. Consequently,
ledger-account writes are never retried by default. When creating ledger entries, use the account id:
Pennylane can expose several ids for the same account number when VAT configurations differ.

There is no documented delete or Ledger Accounts change-log endpoint, so the connector deliberately
does not expose either operation.

## Change logs

Quotes, products, and customers expose incremental change logs at `/changelogs/{resource}`, surfaced
through one shared resource shape. Pennylane retains change events for four weeks; `cursor` and
`start_date` (RFC 3339) are mutually exclusive in both the TypeScript contract and runtime
validation, and `start_date` seeds only the first page.

| Client method | Pennylane endpoint |
| --- | --- |
| `pl.quoteChanges.list / listAll(options?)` | `GET /changelogs/quotes` |
| `pl.productChanges.list / listAll(options?)` | `GET /changelogs/products` |
| `pl.customerChanges.list / listAll(options?)` | `GET /changelogs/customers` |

```ts
for await (const change of pl.productChanges.listAll({
  start_date: "2026-07-01T00:00:00Z",
  limit: 1000,
})) {
  const product = change.operation === "delete" ? null : await pl.products.get(change.id)
  // Apply the change.
}
```

## Errors

Non-successful responses throw `PennylaneApiError` with the status, parsed response body, response
headers, `retryAfterMs`, and request identifier when Pennylane provides one.

```ts
import { PennylaneApiError } from "@sixb/connector-pennylane"

try {
  await pl.quotes.get(42)
} catch (error) {
  if (error instanceof PennylaneApiError) {
    console.error(error.status, error.responseBody, error.requestId)
  }
}
```

## Official documentation

- [Quotes API reference](https://pennylane.readme.io/reference/listquotes)
- [Products API reference](https://pennylane.readme.io/reference/getproducts)
- [Customers API reference](https://pennylane.readme.io/reference/getcustomers)
- [Ledger Accounts API reference](https://pennylane.readme.io/reference/getledgeraccounts)
- [Creating a ledger account](https://pennylane.readme.io/reference/postledgeraccounts)
- [Cursor pagination](https://pennylane.readme.io/docs/using-cursor-based-pagination)
- [Filters](https://pennylane.readme.io/docs/setting-up-filters)
- [Authentication](https://pennylane.readme.io/docs/generating-my-api-token)
- [Errors and status codes](https://pennylane.readme.io/docs/error-handling-status-codes)
- [Rate limiting](https://pennylane.readme.io/docs/rate-limiting-1)

## Not covered yet

Other Pennylane resources such as customer invoices, suppliers, ledger entries, and transactions are
intentionally deferred. The connector's shared HTTP, retry, error, validation, and cursor-pagination
layers are ready for those resource modules.
