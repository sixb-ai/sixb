# @sixb/connector-stripe

Typed Stripe Billing and Payments connector for Sixb. It covers Customers, Subscriptions, Invoices,
Payment Intents, Charges, Refunds, and v1 snapshot Events, with optional verified webhook delivery. Each resource lives in an
independent module so another Stripe surface can be added without growing a monolithic client.

The connector delegates wire-level behavior to Stripe's official SDK: generated request and
response types, form encoding, API-version headers, structured errors, request ids, automatic
network retries, idempotency keys, cursor pagination, and webhook signature verification all
follow Stripe's implementation.

## Register

Create a restricted or secret API key in Stripe Workbench, then define the connector in your
project's `connectors/` directory:

```ts
import { stripe } from "@sixb/connector-stripe"
import { defineConnector } from "@sixb/core"

export const stripeConnector = defineConnector(
  "stripe",
  stripe({
    apiKey: process.env.STRIPE_SECRET_KEY!,
  })
)
```

`createSixb()` discovers the definition automatically. Resolve the typed client with:

```ts
const billing = await sixb.connector(stripeConnector)
```

Never put a secret key in browser code. This package is a server-side connector.

## Options

| Option | Description |
| --- | --- |
| `apiKey` | Required secret key, or async resolver evaluated when Sixb connects the adapter. |
| `maxNetworkRetries` | Retries after the initial request. Defaults to `1` in Stripe's SDK. |
| `timeoutMs` | Per-request timeout. Defaults to 80 seconds in Stripe's SDK. |
| `telemetry` | Set `false` to disable Stripe's request-latency telemetry. |
| `stripeContext` | Account context applied to every request, including Stripe Connect calls. |
| `onEvent` | Handler for inbound v1 snapshot-event webhooks. Registers the `events` route. |
| `webhookSecret` | Endpoint signing secret beginning with `whsec_`. |
| `webhookToleranceMs` | Maximum signature age. Defaults to 5 minutes. |
| `webhooks` | Extra inbound webhooks to register alongside the built-in route. |

For per-request Connect context, API-key rotation, API-version selection, timeout, retry count, or
idempotency, pass `StripeRequestOptions` as the last argument to a resource method:

```ts
await billing.refunds.create(
  { payment_intent: "pi_123", amount: 2_500 },
  {
    idempotencyKey: "refund:order-123:v1",
    stripeContext: "acct_123",
    timeout: 15_000,
  }
)
```

Stripe accepts idempotency keys on every v1 `POST`. The SDK also creates keys when it retries an
eligible write after a network failure. Supply your own stable key when an operation can be
retried by application code or a job runner.

## API version and types

The connector uses the API version bundled with the installed `stripe` SDK. The lockfile currently
resolves `stripe` 22.5.0, whose generated types target `2026-07-29.dahlia`. Upgrade the SDK and
review Stripe's API changelog together: response types intentionally describe the SDK's current API
version, not every historical account version.

Every parameter and object type used by the client is re-exported from this package. Successful
single-object calls return `StripeResponse<T>`, so the object also carries Stripe's response
metadata:

```ts
const customer = await billing.customers.get("cus_123")

console.log(customer.email)
console.log(customer.lastResponse.requestId)
console.log(customer.lastResponse.statusCode)
```

Stripe errors are preserved as the official structured error classes, including `statusCode`,
`requestId`, `code`, `param`, and the raw provider error.

## Pagination

Every collection exposes both the SDK's awaitable page request and an explicit async iterator:

```ts
const firstPage = await billing.invoices.list({ customer: "cus_123", limit: 100 })

for await (const invoice of billing.invoices.listAll({ customer: "cus_123", limit: 100 })) {
  // Map the invoice into a dataset or object.
}
```

`listAll` follows Stripe's `starting_after` cursor. It preserves every initial filter and stops when
`has_more` is false. `starting_after` and `ending_before` are rejected together, and page limits are
validated as integers from 1 to 100 before a request is sent.

Customer, Subscription, Invoice, Payment Intent, and Charge search methods also expose `searchAll`. Stripe Search is
eventually consistent: don't use it for read-after-write flows. Stripe documents normal propagation
under one minute, possible delays up to one hour during outages, and no Search API availability for
merchants in India.

## Customers

| Client method | Stripe endpoint |
| --- | --- |
| `billing.customers.create(params?, options?)` | `POST /v1/customers` |
| `billing.customers.update(id, params?, options?)` | `POST /v1/customers/:id` |
| `billing.customers.get(id, params?, options?)` | `GET /v1/customers/:id` |
| `billing.customers.list(params?, options?)` | `GET /v1/customers` |
| `billing.customers.listAll(params?, options?)` | Auto-pagination over the list endpoint |
| `billing.customers.delete(id, params?, options?)` | `DELETE /v1/customers/:id` |
| `billing.customers.search(params, options?)` | `GET /v1/customers/search` |
| `billing.customers.searchAll(params, options?)` | Auto-pagination over the search endpoint |

Deleting a customer is permanent and immediately cancels that customer's active subscriptions.
Retrieving an already deleted customer returns Stripe's reduced `StripeDeletedCustomer` shape.

## Subscriptions

| Client method | Stripe endpoint |
| --- | --- |
| `billing.subscriptions.create(params, options?)` | `POST /v1/subscriptions` |
| `billing.subscriptions.update(id, params?, options?)` | `POST /v1/subscriptions/:id` |
| `billing.subscriptions.get(id, params?, options?)` | `GET /v1/subscriptions/:id` |
| `billing.subscriptions.list(params?, options?)` | `GET /v1/subscriptions` |
| `billing.subscriptions.listAll(params?, options?)` | Auto-pagination over the list endpoint |
| `billing.subscriptions.cancel(id, params?, options?)` | `DELETE /v1/subscriptions/:id` |
| `billing.subscriptions.migrate(id, params, options?)` | `POST /v1/subscriptions/:id/migrate` |
| `billing.subscriptions.resume(id, params?, options?)` | `POST /v1/subscriptions/:id/resume` |
| `billing.subscriptions.search(params, options?)` | `GET /v1/subscriptions/search` |
| `billing.subscriptions.searchAll(params, options?)` | Auto-pagination over the search endpoint |

`cancel` ends a subscription immediately. To schedule cancellation at the period end, use
`update(id, { cancel_at_period_end: true })` instead.

## Invoices

| Client method | Stripe endpoint |
| --- | --- |
| `billing.invoices.create(params?, options?)` | `POST /v1/invoices` |
| `billing.invoices.createPreview(params?, options?)` | `POST /v1/invoices/create_preview` |
| `billing.invoices.update(id, params?, options?)` | `POST /v1/invoices/:id` |
| `billing.invoices.get(id, params?, options?)` | `GET /v1/invoices/:id` |
| `billing.invoices.list(params?, options?)` | `GET /v1/invoices` |
| `billing.invoices.listAll(params?, options?)` | Auto-pagination over the list endpoint |
| `billing.invoices.delete(id, params?, options?)` | `DELETE /v1/invoices/:id` |
| `billing.invoices.attachPayment(id, params?, options?)` | `POST /v1/invoices/:id/attach_payment` |
| `billing.invoices.finalize(id, params?, options?)` | `POST /v1/invoices/:id/finalize` |
| `billing.invoices.markUncollectible(id, params?, options?)` | `POST /v1/invoices/:id/mark_uncollectible` |
| `billing.invoices.pay(id, params?, options?)` | `POST /v1/invoices/:id/pay` |
| `billing.invoices.send(id, params?, options?)` | `POST /v1/invoices/:id/send` |
| `billing.invoices.void(id, params?, options?)` | `POST /v1/invoices/:id/void` |
| `billing.invoices.search(params, options?)` | `GET /v1/invoices/search` |
| `billing.invoices.searchAll(params, options?)` | Auto-pagination over the search endpoint |

`delete` applies only to eligible draft invoices. Use `void` for a finalized invoice; voiding is
irreversible and preserves the accounting record. A preview is ephemeral and does not appear in
invoice lists.

## Payment Intents

The [Payment Intents API](https://docs.stripe.com/api/payment_intents) manages a payment from
creation through authentication, authorization, and capture. All methods retain the installed
SDK's generated parameter types and return the provider's current state.

| Client method | Stripe endpoint |
| --- | --- |
| `billing.paymentIntents.create(params, options?)` | `POST /v1/payment_intents` |
| `billing.paymentIntents.update(id, params?, options?)` | `POST /v1/payment_intents/:id` |
| `billing.paymentIntents.get(id, params?, options?)` | `GET /v1/payment_intents/:id` |
| `billing.paymentIntents.list(params?, options?)` | `GET /v1/payment_intents` |
| `billing.paymentIntents.listAll(params?, options?)` | Auto-pagination over the list endpoint |
| `billing.paymentIntents.confirm(id, params?, options?)` | `POST /v1/payment_intents/:id/confirm` |
| `billing.paymentIntents.capture(id, params?, options?)` | `POST /v1/payment_intents/:id/capture` |
| `billing.paymentIntents.cancel(id, params?, options?)` | `POST /v1/payment_intents/:id/cancel` |
| `billing.paymentIntents.incrementAuthorization(id, params, options?)` | `POST /v1/payment_intents/:id/increment_authorization` |
| `billing.paymentIntents.applyCustomerBalance(id, params?, options?)` | `POST /v1/payment_intents/:id/apply_customer_balance` |
| `billing.paymentIntents.verifyMicrodeposits(id, params?, options?)` | `POST /v1/payment_intents/:id/verify_microdeposits` |
| `billing.paymentIntents.search(params, options?)` | `GET /v1/payment_intents/search` |
| `billing.paymentIntents.searchAll(params, options?)` | Auto-pagination over the search endpoint |
| `billing.paymentIntents.listAmountDetailsLineItems(id, params?, options?)` | `GET /v1/payment_intents/:id/amount_details_line_items` |
| `billing.paymentIntents.listAllAmountDetailsLineItems(id, params?, options?)` | Auto-pagination over the line-item endpoint |

```ts
const payment = await billing.paymentIntents.create(
  {
    amount: 2_500,
    currency: "eur",
    customer: "cus_123",
    automatic_payment_methods: { enabled: true },
    metadata: { order_id: "order-123" },
  },
  { idempotencyKey: "payment:order-123:v1" }
)

const current = await billing.paymentIntents.get(payment.id)
```

Amounts use the currency's smallest unit. Reuse one PaymentIntent per order or customer session,
with a stable idempotency key for retried writes. `update` does not confirm the payment.
`confirm` can return `requires_action` and `next_action`; the application must complete the
authentication flow with Stripe's client SDK. Never log or put `client_secret` in URLs, and only
send it to the customer completing that payment.

`capture` applies to payments in `requires_capture`; `amount_to_capture` supports partial capture.
Stripe enforces eligibility for cancellation, incremental authorization, customer-balance
reconciliation, and microdeposit verification. Refund completed payments through `billing.refunds`.

Existing verified webhooks also receive `payment_intent.*` snapshot events. Handle
`payment_intent.succeeded` for successful payment reconciliation; a successful HTTP response from
`create` or `confirm` alone does not mean the payment has succeeded.

## Charges

The [Charges API](https://docs.stripe.com/api/charges) exposes individual payment attempts,
including captured/refunded amounts, payment-method details, receipts, and the balance transaction.

| Client method | Stripe endpoint |
| --- | --- |
| `billing.charges.get(id, params?, options?)` | `GET /v1/charges/:id` |
| `billing.charges.update(id, params?, options?)` | `POST /v1/charges/:id` |
| `billing.charges.list(params?, options?)` | `GET /v1/charges` |
| `billing.charges.listAll(params?, options?)` | Auto-pagination over the list endpoint |
| `billing.charges.search(params, options?)` | `GET /v1/charges/search` |
| `billing.charges.searchAll(params, options?)` | Auto-pagination over the search endpoint |

```ts
for await (const charge of billing.charges.listAll({ payment_intent: "pi_123", limit: 100 })) {
  // Reconcile each attempt, including unsuccessful charges.
}

const charge = await billing.charges.get("ch_123", { expand: ["balance_transaction"] })
await billing.charges.update(charge.id, { metadata: { order_id: "order-123" } })
```

Lists accept customer, creation-date, PaymentIntent, and transfer-group filters. Stripe limits
transfer-group filtering to 100 charges. Search has the consistency limitations described above.
`update` changes the fields Stripe permits, such as metadata and description; changing
`receipt_email` sends a new receipt.

Create and capture payments through `billing.paymentIntents`, and refund them through
`billing.refunds`. Direct charge creation and capture are intentionally not exposed.
The existing verified event webhook also accepts `charge.*` snapshot events.

## Refunds

| Client method | Stripe endpoint |
| --- | --- |
| `billing.refunds.create(params, options?)` | `POST /v1/refunds` |
| `billing.refunds.update(id, params?, options?)` | `POST /v1/refunds/:id` |
| `billing.refunds.get(id, params?, options?)` | `GET /v1/refunds/:id` |
| `billing.refunds.list(params?, options?)` | `GET /v1/refunds` |
| `billing.refunds.listAll(params?, options?)` | Auto-pagination over the list endpoint |
| `billing.refunds.cancel(id, params?, options?)` | `POST /v1/refunds/:id/cancel` |

Create a refund against a Charge or PaymentIntent. Stripe allows partial refunds up to the remaining
unrefunded amount. `update` currently changes metadata only. `cancel` only applies to refunds in
`requires_action`; refunds in other states cannot be canceled.

## Events and webhooks

The Events API supports polling and backfills for the previous 30 days:

| Client method | Stripe endpoint |
| --- | --- |
| `billing.events.get(id, params?, options?)` | `GET /v1/events/:id` |
| `billing.events.list(params?, options?)` | `GET /v1/events` |
| `billing.events.listAll(params?, options?)` | Auto-pagination over the list endpoint |

An event's `data.object` is rendered with the API version recorded in `event.api_version`, not the
version used by the current request.

For real-time delivery, configure a v1 snapshot event destination in Stripe Workbench and point it
at Sixb's connector webhook route:

```text
POST /api/webhooks/stripe/events
```

Then configure the signing secret and handler:

```ts
export const stripeConnector = defineConnector(
  "stripe",
  stripe({
    apiKey: process.env.STRIPE_SECRET_KEY!,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
    onEvent: async ({ event, logger, client }) => {
      logger.info(`[Stripe] ${event.type}`, event.id)

      if (event.type === "invoice.paid") {
        const stripe = await client()
        const invoice = await stripe.invoices.get(event.data.object.id)
        // Reconcile the current invoice state.
      }
    },
  })
)
```

The route verifies `Stripe-Signature` against the exact raw request bytes with Stripe's official
SDK and rejects stale signatures outside the replay window. The event id is used as Sixb's delivery
idempotency key because Stripe retries webhook deliveries. Missing secrets fail startup unless
`webhookAllowUnverified: true` is explicitly set.

This route handles v1 snapshot events. Stripe v2 thin events have a different payload and retrieval
model and are intentionally outside this connector's current Events resource.

## Cancellation limitation

The Stripe 22.5.0 SDK does not expose `AbortSignal` in its request options. Sixb therefore refuses a
new connection when its lifecycle signal is already aborted, but it cannot interrupt an individual
Stripe request already in flight. Keep `timeoutMs` bounded; the SDK default is 80 seconds. Native
`AbortSignal` support in Stripe's SDK would remove this limitation.

## Test mode and sandboxes

Use `sk_test_...` keys for test mode or a secret key created inside a Stripe Sandbox. Stripe uses the
same API host for live mode, test mode, and Sandboxes; the key selects the environment. Test webhook
signing secrets and live signing secrets are different, even when the endpoint URL is identical.
