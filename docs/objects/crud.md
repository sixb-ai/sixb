# Reading & Writing

Create, read, and list objects through the typed API. Reach for this whenever you need to
write a record, fetch one by id, or page through a type's objects in code.

Once an object type is registered, `sixb.objects(Type)` returns a typed collection ("object
set"). TypeScript infers property names and value types from your
[ontology](../ontology/overview.md), so writes and reads are checked as you type.

```ts
import { Invoice } from "./ontology/invoice"

const invoices = sixb.objects(Invoice)
```

The methods below live on that object set. For filtering, search, and link traversal see
[Querying](./querying.md). For time-series values see [Telemetry](./telemetry.md).

## upsert

`upsert` creates an object if it does not exist, or updates it if it does. It is keyed by the
[primary property](../ontology/properties.md) declared on the object type.

The primary id goes **inside `properties`** — there is no separate `key` field. Upsert throws
if it is missing.

```ts
const invoice = await invoices.upsert({
  properties: {
    id: "inv-001",
    number: "INV-2026-001",
    amount: 4800,
    currency: "EUR",
    status: "sent",
    dueDate: "2026-07-15",
  },
})
```

The return value is the stored object, including `createdAt` and `updatedAt` as `Date` values.

### Merge semantics

Upsert merges into the existing record. Only the properties you pass are written; omitted
properties keep their current values, so you can update one field without re-sending the whole
object.

```ts
// Creates the invoice
await invoices.upsert({ properties: { id: "inv-001", number: "INV-2026-001", amount: 4800 } })

// Updates only `status`; `number` and `amount` are preserved
await invoices.upsert({ properties: { id: "inv-001", status: "paid" } })
```

Required properties are checked against the merged result, not just the incoming fields, so a
later partial update of an existing object need not repeat required values.

### Dates are normalized

The typed surface accepts `Date | string` for `date` and `timestamp` properties. Before storage,
`Date` values are normalized to ISO strings. Both forms below are equivalent:

```ts
await invoices.upsert({ properties: { id: "inv-001", issuedAt: new Date() } })
await invoices.upsert({ properties: { id: "inv-001", issuedAt: "2026-06-23T00:00:00.000Z" } })
```

### Events

Each successful upsert appends either an `object.created` or `object.updated` [event](../events/overview.md), including the full resulting properties and their changes. The object record is projected from that event, and [rules](../rules/overview.md) and [workflows](../workflows/overview.md) can react to it.

## get

`get(id)` reads a single object by its primary id. It returns the object, or `null` if none
exists.

```ts
const invoice = await invoices.get("inv-001")

if (invoice) {
  console.log(invoice.properties.amount, invoice.properties.status)
  console.log(invoice.createdAt, invoice.updatedAt)
}
```

The returned object has this shape:

| Field | Type | Meaning |
| --- | --- | --- |
| `primaryId` | `string` | The object's primary id |
| `objectTypeId` | `string` | The object type id, like `"Invoice"` |
| `properties` | typed | Property values inferred from the ontology |
| `createdAt` | `Date` | When the object was first written |
| `updatedAt` | `Date` | When the object was last written |

You can also read through a [handle](#the-byid-handle): `invoices.byId("inv-001").get()`.

## list

`list(...)` browses stored objects of this type directly from storage — a fast, index-friendly
scan by primary id and timestamps. Use it to page through objects or fetch a window of recent
records. For property predicates, full-text search, or link traversal, use
[`query()`](#list-vs-query) instead.

```ts
const { objects, hasMore, total } = await invoices.list({
  limit: 200,
  orderBy: "updatedAt",
  order: "desc",
})
```

All options are optional:

| Option | Type | Meaning |
| --- | --- | --- |
| `idPrefix` | `string` | Only ids starting with this prefix |
| `idSuffix` | `string` | Only ids ending with this suffix |
| `createdAfter` | `Date` | Created strictly after this time |
| `createdBefore` | `Date` | Created strictly before this time |
| `updatedAfter` | `Date` | Updated strictly after this time |
| `updatedBefore` | `Date` | Updated strictly before this time |
| `limit` | `number` | Maximum objects to return |
| `offset` | `number` | Objects to skip, for paging |
| `orderBy` | `"createdAt" \| "updatedAt" \| "primaryId"` | Sort key |
| `order` | `"asc" \| "desc"` | Sort direction |

The result is `{ objects, hasMore, total }`: the matching `objects`, a `hasMore` flag, and the
`total` count matching the filters. Page through with `offset` and `limit`:

```ts
const page1 = await invoices.list({ limit: 50, offset: 0, orderBy: "primaryId" })
const page2 = await invoices.list({ limit: 50, offset: 50, orderBy: "primaryId" })
```

### list vs query

| Use | Reach for |
| --- | --- |
| Browse by id prefix/suffix, created/updated time, or page raw records | `list(...)` |
| Filter by property values, search text, traverse links, aggregate | `query()` |

```ts
// Storage browse: recent records, no property filter
const recent = await invoices.list({ orderBy: "updatedAt", order: "desc", limit: 20 })

// Query: filter by a property value (status is filterable in the ontology)
const overdue = await invoices
  .query()
  .where((i) => i.p.status.eq("overdue"))
  .limit(10)
  .list()
```

Only properties that declare [query metadata](../ontology/search-metadata.md) can be filtered or
sorted. See [Querying](./querying.md) for the full builder.

## The byId handle

`byId(id)` returns a handle bound to one object id. It is the entry point for per-object
operations: reading, [links](../ontology/links.md), [telemetry](./telemetry.md), and
[actions](../actions/overview.md).

```ts
const handle = invoices.byId("inv-001")

await handle.get()

// Link to a customer (link tokens live on Type.l.*, targets are object refs)
await handle.link(Invoice.l.customer, { objectTypeId: "Customer", primaryId: "cust-001" })

await handle.requestAction({ actionId: "markPaid" })
```

The handle does not check that the object exists when you create it; operations are validated
when they run.

## requestAction

`requestAction` requests an [action](../actions/overview.md) against an object. It enqueues the
request and returns immediately; a handler runs the action asynchronously.

On a `byId` handle, pass the action id (or an imported action definition) and any params:

```ts
await invoices.byId("inv-001").requestAction({
  actionId: "markPaid",
  params: { paymentMethod: "wire", paymentReference: "txn-9921" },
})
```

On the object set, also pass the target `id`:

```ts
await invoices.requestAction({
  id: "inv-001",
  actionId: "sendReminder",
})
```

Both forms accept either `actionId` (a string) or `action` (an imported action definition). Use
`requestActionAndWait(...)` to block until the action completes. See
[Actions](../actions/overview.md) for handlers, params, and results.

## appendTelemetryBatch

`appendTelemetryBatch` appends [telemetry](./telemetry.md) values to many objects in one call.
Each item names the target by primary id and the telemetry property values to append.

```ts
await projects.appendTelemetryBatch([
  { id: "proj-001", properties: { progress: 40 } },
  { id: "proj-002", properties: { progress: 75 } },
])
```

For appending to a single object and reading history, see [Telemetry](./telemetry.md).

## Related

- [Querying](./querying.md) — filters, search, link traversal, aggregation
- [Telemetry](./telemetry.md) — time-series property values
- [Actions](../actions/overview.md) — requesting commands against objects
- [HTTP reference](./http-reference.md) — the same operations over HTTP
