# Webhooks

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

## Managed OAuth webhooks

OAuth adapters use the same webhook builder. Resolve managed clients inside the handler with
`connections.forAccount(accountId)`:

```ts
webhooks: [
  defineWebhook("events")
    .post()
    .json(providerBatchSchema)
    .verify(verifyProviderSignature)
    .handle<ProviderClient>(async ({ body, connections }) => {
      for (const event of body) {
        for (const target of await connections.forAccount(event.accountId)) {
          await onChange({ event, connection: target.connection, client: target.client })
        }
      }
      return { status: 200 }
    }),
],
```

`connections.forAccount(accountId)` returns the matching connected accounts, or an empty array.
Call `target.client()` to access each account's authenticated client. The top-level `client()` is
for static connectors; OAuth handlers must resolve an account first.

Use the existing `.idempotencyKey(...)` when the provider supplies a stable delivery identity.
Deduplication applies to the complete request. A failed batch can repeat earlier effects on retry,
so make handler writes idempotent.

## Webhooks updating source datasets

Use [`sixb.datasets.ingest`](#ingest-source-changes) to update the same source rows as a
sync. These examples use the sequenced [`people` dataset](../datasets/source-ordering.md#source-ordering).

**Webhook handler:** fetch the current record and submit a complete row.

```ts
.handle(async ({ body, client, sixb, request }) => {
  const crm = await client()
  const person = await crm.getPerson(body.personId)
  await sixb.datasets.ingest(people, {
    changes: [change.upsert({
      id: String(person.id),
      name: person.name,
      updatedAt: person.updatedAt,
    })],
    signal: request.signal,
  })
})
```

**Snapshot sync:** use the same row mapping and source timestamp.

```ts
export const syncPeople = defineSync("crm-people")
  .from(crmConnector)
  .read(async (crm) => (await crm.listPeople()).map((person) => ({
    id: String(person.id),
    name: person.name,
    updatedAt: person.updatedAt,
  })))
  .intoDataset(people)
```

**Downstream pipeline:** attach a dataset-update schedule with `.when(peopleUpdated)`.

```ts
export const peopleUpdated = defineSchedule("crm-people-updated")
  .on(events.dataset(people).updated())
```

- Equal source revisions must map to identical rows. Use source time, never fetch time.
- Missing snapshot rows stay. Delete explicitly with `change.delete(key, { sequence })`.
- Delivery deduplication runs before the handler. See [recovery limits](#ingestion-recovery).

## Ingest source changes

Webhook handlers and other trusted backend executions can update a registered, keyed dataset:

```ts
const result = await sixb.datasets.ingest(people, {
  changes: [
    change.upsert({ id: "42", name: "Sam", updatedAt: "2026-09-09T10:00:00.123Z" }),
    change.delete({ id: "9" }, { sequence: "2026-09-09T10:01:00.000Z" }),
  ],
})
```

| Contract | Behavior |
| --- | --- |
| Input | Iterable or async iterable of complete-row upserts and primary-key deletes |
| Cancellation | Optional `signal: AbortSignal` |
| Validation | Registered schema, primary key, source sequence, and referenced blobs |
| Result | `{ outcome: "created" \| "unchanged", version, rowsRead }`; `version` can be `null` for an initial no-op |
| Downstream work | New versions emit `dataset.version.committed`; pipelines/projections run asynchronously |
| Authority | Trusted backend executions, or explicitly disabled authorization; dataset-view grants do not permit ingestion |

Use [`sequenceBy`](../datasets/source-ordering.md) when [webhooks and syncs share a dataset](#webhooks-updating-source-datasets).

| Dataset | Concurrent writes | Snapshot sync |
| --- | --- | --- |
| With `sequenceBy` | Newer source values win; concurrency conflicts retry | Ordered upserts; omitted rows stay |
| Without `sequenceBy` | A concurrent version change fails ingestion | Replaces rows |

**Existing unkeyed dataset?** Create a new keyed dataset → backfill → repoint consumers.
Stored primary keys and `sequenceBy` are immutable.

### Objects and relationships

Ingestion updates source data. Existing pipelines and projections determine the object result:

| Change | Downstream behavior |
| --- | --- |
| Source record updated | Pipeline recalculates merged data; projection updates its properties and links |
| Application edit | Projection's [conflict policy](../projections/overview.md#source-and-managed-edit-conflict-resolution) still applies |
| Source row removed | Projection withdraws its claims; the ontology object is not automatically deleted |
| Foreign-key target missing | Properties can materialize, but no edge is created; the old source-owned link is withdrawn |

### Ingestion recovery

> Commits and notifications are separate. A crash can leave committed data without its notification
> or completed run record. Durable receipts and automatic notification recovery are deferred.

- Notification failures are reported through `onError`.
- Identical sequenced retries are no-ops; they do not resend notifications.
- Rerun the downstream pipeline after missed notifications or pipeline failures:

```ts
await sixb.pipelines.request({ pipelineId: "merge-contacts" })
```
