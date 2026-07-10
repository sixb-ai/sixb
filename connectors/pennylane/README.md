# @sixb/connector-pennylane

Typed Pennylane Company API v2 connector for Sixb. The first release covers the complete Quotes API
surface and is structured around independent resources so other Pennylane endpoints can be added
without growing a monolithic client.

## Register

Create a Company API token with `quotes:readonly` for reads or `quotes:all` for writes, then define the
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
default: even `PUT /quotes/{id}` can create invoice lines, so treating every PUT as idempotent could
duplicate data.

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
| `pl.quoteChanges.list(options?)` | `GET /changelogs/quotes` |
| `pl.quoteChanges.listAll(options?)` | Cursor iterator over quote changes |

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

Quote change events are retained by Pennylane for four weeks. `cursor` and `start_date` are mutually
exclusive in both the TypeScript contract and runtime validation:

```ts
for await (const change of pl.quoteChanges.listAll({
  start_date: "2026-07-01T00:00:00Z",
  limit: 1000,
})) {
  const quote = change.operation === "delete" ? null : await pl.quotes.get(change.id)
  // Apply the change.
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
- [Cursor pagination](https://pennylane.readme.io/docs/using-cursor-based-pagination)
- [Filters](https://pennylane.readme.io/docs/setting-up-filters)
- [Authentication](https://pennylane.readme.io/docs/generating-my-api-token)
- [Errors and status codes](https://pennylane.readme.io/docs/error-handling-status-codes)
- [Rate limiting](https://pennylane.readme.io/docs/rate-limiting-1)

## Not covered yet

Other Pennylane resources such as customers, products, customer invoices, suppliers, ledger entries,
and transactions are intentionally deferred. The connector's shared HTTP, retry, error, validation,
and cursor-pagination layers are ready for those resource modules.
