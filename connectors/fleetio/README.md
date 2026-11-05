# @sixb/connector-fleetio

Typed [Fleetio](https://www.fleetio.com) API connector for Sixb. It covers work orders, issues,
service history and reminders, vehicles, contacts, vendors, equipment, parts, purchase orders,
meter, fuel and expense entries, faults, inspections and webhooks, and uses Fleetio API version
`2025-05-05`.

## Register

Create an API key and copy your account token on the
[Manage API Keys page](https://secure.fleetio.com/api_keys), then define the connector in your
project's `connectors/` directory:

```ts
import { fleetio } from "@sixb/connector-fleetio"
import { defineConnector } from "@sixb/core"

export const fleetioConnector = defineConnector(
  "fleetio",
  fleetio({
    apiKey: process.env.FLEETIO_API_KEY!,
    accountToken: process.env.FLEETIO_ACCOUNT_TOKEN!,
  })
)
```

`createSixb()` discovers the definition automatically. Resolve the typed client with:

```ts
const fl = await sixb.connector(fleetioConnector)
```

An API key acts as one Fleetio user, with that user's role and permissions. A call the user may not
make fails with a `403`, so give each integration its own user with only the access it needs.

Fleetio hides its trial sample data from the API, so a trial account needs its own records.

## Options

| Option | Description |
| --- | --- |
| `apiKey` | Required. A string or async function, resolved for every attempt. |
| `accountToken` | Required. A string or async function, resolved for every attempt. |
| `baseUrl` | Defaults to `https://secure.fleetio.com/api/`. |
| `apiVersion` | Sent as `X-Api-Version`. Defaults to `2025-05-05`, the version these types describe. |
| `timeoutMs` | Optional per-attempt timeout. |
| `minDelayMs` | Delay between request starts. Defaults to `0`. |
| `retry` | Retry policy: `maxRetries`, `shouldRetry`, `delayMs`. Defaults to two retries. |
| `onEvent` | Handler for inbound webhook deliveries. Providing it registers the `events` route. |
| `webhookSecret` | The webhook's secret. Deliveries are rejected unless the signature verifies. |
| `webhookAllowUnverified` | Register the route without a secret. Without this, a missing secret is an error. |

## Work orders

```ts
// Open a job for a vehicle
const statuses = await fl.workOrderStatuses.list()
const open = statuses.records.find((status) => status.default)

const order = await fl.workOrders.create({
  vehicle_id: 123,
  work_order_status_id: open!.id,
  issued_at: "2026-11-05T09:00:00Z",
})

// Add a task with a part and labor
await fl.workOrderLineItems.create(order.id, {
  type: "WorkOrderServiceTaskLineItem",
  item_type: "ServiceTask",
  item_id: 12345,
  work_order_sub_line_items_attributes: [
    { item_type: "Part", item_id: 101, unit_cost: 9.95, quantity: 2 },
    { item_type: "Contact", item_id: 4455, unit_cost: 24, quantity: 0.5 },
  ],
})
```

A sub line item with `item_type: "Contact"` is labor, and `"Part"` is a part. `list` returns a
shorter record than `get`: only `get` includes line items and costs.

## Lists, filters and sorting

`list` returns one page and `listAll` iterates every page. Both take `pageSize` (1 to 100, default
50), `cursor`, and a `filter` and `sort` typed for that endpoint. They mirror Fleetio's
[filter syntax](https://developer.fleetio.com/docs/overview/filtering-and-sorting):

```ts
const page = await fl.workOrders.list({
  pageSize: 100,
  filter: { work_order_status_name: { include: ["Open", "In Progress"] } },
  sort: { created_at: "desc" },
})

page.records // the work orders
page.next_cursor // pass as `cursor` for the next page, or null on the last page

for await (const order of fl.workOrders.listAll({ filter: { vehicle_id: { eq: 123 } } })) {
  console.log(order.number)
}
```

To pull what changed since the last run, filter and sort on `updated_at`. Bounds can be combined to
select a window:

```ts
for await (const order of fl.workOrders.listAll({
  filter: { updated_at: { gte: lastSyncedAt, lt: now } },
  sort: { updated_at: "asc" },
})) {
  // upsert order
}
```

`estimated_remaining_count` stops counting at 500, so it is not a total.

## Client API

Unless noted, a resource has `list`, `listAll` and `get`, plus `create`, `update` and `delete` where
Fleetio allows writes. An `update` returns the record where Fleetio does, and otherwise resolves to
nothing; its type says which.

### Maintenance

| Resource | Operations |
| --- | --- |
| `fl.workOrders` | Full |
| `fl.workOrderLineItems` | Full, with the work order's ID first: `list(workOrderId)`, `get(workOrderId, id)` |
| `fl.workOrderStatuses` | Read only |
| `fl.issues` | Full, plus `close`, `resolve`, `reopen`. `get(id, { includes })` |
| `fl.issuePriorities` | Read only |
| `fl.serviceTasks` | Full. `get(id, { expand })` |
| `fl.serviceEntries` | Full |
| `fl.serviceEntryLineItems` | Full, with the service entry's ID first |
| `fl.serviceReminders` | Full |
| `fl.vmrsReasonsForRepair` | `list` only; Fleetio returns the whole list unpaged |

### Fleet

| Resource | Operations |
| --- | --- |
| `fl.vehicles` | Full, plus `search`, `archive`, `restore`, archived lists and the lists below |
| `fl.vehicleStatuses`, `fl.vehicleTypes` | Full |
| `fl.vehicleAssignments` | Full, plus `unassign` |
| `fl.contacts` | Full, plus `search`, `archive`, `restore`, archived lists. `get(id, { expand })` |
| `fl.vendors` | Full, plus `archive`, `restore`, archived lists |
| `fl.groups` | Full |
| `fl.equipment` | Full, plus `archive`, `restore` |
| `fl.equipmentStatuses`, `fl.equipmentTypes` | Read only |

Where your account has
[external IDs](https://developer.fleetio.com/docs/guides/vehicles/external-vehicle-ids) configured,
a vehicle ID can also be `key:value`, such as `fl.vehicles.get("vin:A12B34C56D78")`. Each of these
has a `listAll…` form and takes the vehicle's ID first: `listFuelEntries`, `listMeterEntries`,
`listServiceEntries`, `listAssignments`, `listIssues`, `listLinkedVehicles`. `getCurrentAssignment`
and `getPurchaseDetail` return one record.

`search` takes the same options as `list` and sends them in a request body, which suits long filters.

### Parts and purchasing

| Resource | Operations |
| --- | --- |
| `fl.parts` | Full, plus `archive`, `restore`, archived lists. `get(id, { partLocationIds })` |
| `fl.partLocations` | `list`, `listAll` |
| `fl.partLocationDetails` | `list`, `listAll`, `listInventorySets`, `listAllInventorySets` |
| `fl.inventoryJournalEntries` | `list`, `listAll`, `get`, `create` |
| `fl.inventoryAdjustmentReasons` | `list`, `listAll` |
| `fl.purchaseOrders` | Full, by `number`. Plus `submitForApproval`, `approve`, `reject`, `purchase`, `undoPurchase`, `close` |
| `fl.purchaseOrderLineItems` | Full, with the purchase order's `number` first |

### Readings and inspections

| Resource | Operations |
| --- | --- |
| `fl.meterEntries`, `fl.fuelEntries`, `fl.expenseEntries`, `fl.faults` | Full |
| `fl.fuelTypes`, `fl.expenseEntryTypes` | Read only |
| `fl.inspectionForms` | Read only |
| `fl.submittedInspectionForms` | Read and `delete`; Fleetio takes no submissions through its API |
| `fl.inspectionSchedules` | Read only. `get(id, { includeOccurrences })` |

### Shared

| Resource | Operations |
| --- | --- |
| `fl.comments` | Full, on a record named by `commentable_type` and `commentable_id` |
| `fl.labels` | `list`, `listAll`, `create` |
| `fl.watchers` | `list`, `listAll`, `search`, `searchAll`, `watch`, `unwatch`, all by `(type, id)` |
| `fl.customFields` | `list`, `listAll` |
| `fl.users` | `me()`, the user the API key belongs to |
| `fl.webhooks` | Full |
| `fl.webhookEvents` | Read only: delivery history, kept for 30 days |
| `fl.bulkJobs` | `create`, `get` |
| `fl.uploads` | `upload` |

Custom field values are read and written on each record's `custom_fields`, keyed by field `key`.

## Attach files

`upload` stores a file and returns the URL to attach:

```ts
const photo = await fl.uploads.upload(file)

await fl.workOrders.update(order.id, {
  images_attributes: [{ name: "Damage", file_url: photo.url }],
})
```

The file goes to Fleetio's file host, authorized by a signed policy. Your credentials are not sent
there.

## Bulk jobs

Fleetio suggests its Bulk API above 20 requests a minute. A job takes up to 100 records, or 500 for
inventory and 1000 for groups. It sends no notice on completion, so poll:

```ts
const job = await fl.bulkJobs.create({
  resource: "meter_entry",
  operation: "create",
  records: [{ vehicle_id: 123, date: "2026-11-05", value: 10500 }],
})

const finished = await fl.bulkJobs.get(job.id)
if (finished.state === "complete") {
  console.log(finished.failed_records)
}
```

## Webhooks

### Receive events

Set `onEvent` and `webhookSecret`. Fleetio delivers every subscribed event to one route,
`/api/webhooks/<connector-id>/events`, so switch on `event.type`:

```ts
fleetio({
  apiKey: process.env.FLEETIO_API_KEY!,
  accountToken: process.env.FLEETIO_ACCOUNT_TOKEN!,
  webhookSecret: process.env.FLEETIO_WEBHOOK_SECRET,
  onEvent: async ({ event, client }) => {
    if (event.type === "work_order_updated") {
      const fl = await client()
      const order = await fl.workOrders.get(event.payload.id as number)
      // upsert order
    }
  },
})
```

`event` is `{ id, type, timestamp, triggeredBy, payload }`. Each delivery's
`X-Fleetio-Webhook-Signature` is checked against the raw body before `onEvent` runs.

**Keep handlers short.** Fleetio expects a `200` within 30 seconds and disables a webhook after three
failed messages, so hand long work to a workflow.

**Make handlers safe to repeat.** Fleetio retries failed deliveries for about a day, and a retry runs
your handler again. `event.id` identifies the delivery.

**Re-fetch rather than trust the order.** Update events are debounced and can arrive late or out of
order, so read the current record as above.

### Register a webhook

Add it in Fleetio under Account Settings, or from a script. The response's `shared_key` is your
`webhookSecret`:

```ts
const webhook = await fl.webhooks.create({
  url: "https://<your-host>/api/webhooks/fleetio/events",
  work_order_created: true,
  work_order_updated: true,
  work_order_status_changed: true,
})
```

If Fleetio disabled a webhook, `disabled_at` and `disabled_reason` say why, `update(id, { enabled:
true })` turns it back on, and `fl.webhookEvents.listAll()` shows what was missed.

## Errors and retries

A non-2xx response throws `FleetioApiError` with `status`, `responseBody`, `headers` and
`retryAfterMs`. On a `400` or `422`, `validationErrors` holds the messages for each field. A problem
with the connector's own configuration throws `FleetioConfigurationError`.

Reads retry network errors, `429` and `5xx`. Fleetio has no idempotency keys, so writes retry only a
`429`, where Fleetio refused the request. Retries wait for `Retry-After`.

Fleetio's rate limit depends on your plan. Set `minDelayMs` to stay under it: `240` allows 250 requests
a minute. It paces this connector instance only, so leave room if anything else uses the same key.

## Notes

- **Field names** are Fleetio's own, in snake_case, so its API reference applies directly.
- **Datetimes** without an offset are read in the API user's time zone, so send UTC or an offset.
- **Types follow real responses** where those differ from Fleetio's spec. Fields seen only in responses
  are optional.
- **Some modules are plan-dependent.** A call to one your account lacks fails with a `403` or `404`.
- **Not covered:** accidents, custom objects and records, motor pool, tires and axles, warranties, EV
  charging, renewals, location history, fault rules, vehicle acquisitions, and account administration.
