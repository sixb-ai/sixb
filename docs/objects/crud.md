# Reading & Writing

Create, read, and list objects through the typed API.

Once an object type is registered, `sixb.objects(Type)` gives you a typed collection
("object set"). TypeScript infers property names and value types from your
[ontology](../ontology/overview.md), so writes and reads are checked as you type.

```ts
import { Customer } from "./ontology/customer"

const customers = sixb.objects(Customer)
```

The methods below live on that object set. For filtering, search, and link traversal see
[Querying](./querying.md). For time-series values see [Telemetry](./telemetry.md).

## upsert

`upsert` creates an object if it does not exist, or updates it if it does. It is keyed by the
[primary property](../ontology/properties.md) declared on the object type.

```ts
const customer = await customers.upsert({
  properties: {
    id: "cust-001",
    name: "Acme Corp",
    email: "team@acme.example",
    tier: "enterprise",
  },
})
```

The argument is always an object with a `properties` field. The primary property
(here `id`) is required — upsert throws if it is missing.

### Merge semantics

Upsert merges into the existing record. Only the properties you pass are written; properties
you omit keep their current values. This means you can update one field without re-sending the
whole object.

```ts
// Creates the customer
await customers.upsert({ properties: { id: "cust-001", name: "Acme Corp" } })

// Updates only `tier`; `name` is preserved
await customers.upsert({ properties: { id: "cust-001", tier: "enterprise" } })
```

Required properties are checked against the merged result, not just the incoming fields, so a
later partial update of an existing object does not need to repeat required values.

### Events

Each successful upsert appends an `object.upserted`
[event](../events/overview.md) carrying the object type id, primary id, and the properties you
wrote. The object record is then projected from that event. Rules, workflows, and functions can
react to `object.upserted`.

### Dates are normalized

The typed surface accepts `Date | string` for date and timestamp properties. Before the value
is stored, `Date` values are normalized to ISO strings (the event store only accepts JSON). Both
forms below are equivalent:

```ts
await customers.upsert({
  properties: { id: "cust-001", signedUpAt: new Date() },
})

await customers.upsert({
  properties: { id: "cust-001", signedUpAt: "2026-06-23T00:00:00.000Z" },
})
```

The return value is the stored object, including `createdAt` and `updatedAt` as `Date` values.

## get

`get(id)` reads a single object by its primary id. It returns the object, or `null` if no
object with that id exists.

```ts
const customer = await customers.get("cust-001")

if (customer) {
  console.log(customer.properties.name)
  console.log(customer.createdAt, customer.updatedAt)
}
```

The returned object has this shape:

| Field | Type | Meaning |
| --- | --- | --- |
| `primaryId` | `string` | The object's primary id |
| `objectTypeId` | `string` | The object type id, like `"Customer"` |
| `properties` | typed | Property values inferred from the ontology |
| `createdAt` | `Date` | When the object was first written |
| `updatedAt` | `Date` | When the object was last written |

You can also read through a [handle](#the-byid-handle): `customers.byId("cust-001").get()`.

## list

`list(...)` browses stored objects of this type directly from storage. It is a fast,
index-friendly scan by primary id and timestamps — use it to page through objects or to fetch a
window of recent records. For property predicates, full-text search, or link traversal, use
[`query()`](#list-vs-query) instead.

```ts
const { objects, hasMore, total } = await customers.list({
  limit: 200,
  orderBy: "updatedAt",
  order: "desc",
})
```

`list` accepts these options (all optional):

| Option | Type | Meaning |
| --- | --- | --- |
| `idPrefix` | `string` | Only objects whose primary id starts with this prefix |
| `idSuffix` | `string` | Only objects whose primary id ends with this suffix |
| `createdAfter` | `Date` | Only objects created strictly after this time |
| `createdBefore` | `Date` | Only objects created strictly before this time |
| `updatedAfter` | `Date` | Only objects updated strictly after this time |
| `updatedBefore` | `Date` | Only objects updated strictly before this time |
| `limit` | `number` | Maximum number of objects to return |
| `offset` | `number` | Number of objects to skip, for paging |
| `orderBy` | `"createdAt" \| "updatedAt" \| "primaryId"` | Sort key |
| `order` | `"asc" \| "desc"` | Sort direction |

The result is:

| Field | Type | Meaning |
| --- | --- | --- |
| `objects` | `TwinObject[]` | The matching objects |
| `hasMore` | `boolean` | Whether more objects exist past this page |
| `total` | `number` | Total count matching the filters |

Page through with `offset` and `limit`:

```ts
const page1 = await customers.list({ limit: 50, offset: 0, orderBy: "primaryId" })
const page2 = await customers.list({ limit: 50, offset: 50, orderBy: "primaryId" })
```

### list vs query

| Use | Reach for |
| --- | --- |
| Browse by id prefix/suffix, created/updated time, or page raw records | `list(...)` |
| Filter by property values, search text, traverse links, aggregate | `query()` |

```ts
// Storage browse: recent objects, no property filter
const recent = await customers.list({ orderBy: "updatedAt", order: "desc", limit: 20 })

// Query: filter by a property value
const enterprise = await customers
  .query()
  .where((c) => c.p.tier.eq("enterprise"))
  .limit(10)
  .list()
```

See [Querying](./querying.md) for the full query builder.

## The byId handle

`byId(id)` returns a handle bound to one object id. It is the entry point for per-object
operations: reading, [links](../ontology/links.md), [telemetry](./telemetry.md), and
[actions](../actions/overview.md).

```ts
const handle = customers.byId("cust-001")

await handle.get()
await handle.link(Customer.l.belongsTo, { objectTypeId: "Organization", primaryId: "org-001" })
await handle.telemetry(Customer.p.monthlySpend).append({ value: 1250, at: new Date() })
await handle.requestAction({ actionId: "issueCredit", params: { amount: 500 } })
```

The handle does not check that the object exists when you create it; operations are validated
when they run.

## requestAction

`requestAction` requests an [action](../actions/overview.md) against an object. It enqueues the
request and returns immediately; a handler runs the action asynchronously.

On a `byId` handle, pass the action id (or an action definition) and params:

```ts
await customers.byId("cust-001").requestAction({
  actionId: "issueCredit",
  params: { amount: 500 },
})
```

On the object set, also pass the target `id`:

```ts
await customers.requestAction({
  id: "cust-001",
  actionId: "issueCredit",
  params: { amount: 500 },
})
```

Both forms accept either `actionId` (a string) or `action` (an imported action definition).
Use `requestActionAndWait(...)` to block until the action completes. See
[Actions](../actions/overview.md) for handlers, params, and results.

## appendTelemetryBatch

`appendTelemetryBatch` appends [telemetry](./telemetry.md) values to many objects in one call.
Each item names the target object by primary id and the telemetry property values to append.

```ts
await sensors.appendTelemetryBatch([
  { id: "sensor-001", properties: { temperature: { value: 21.5, unit: "degreeCelsius" } } },
  { id: "sensor-002", properties: { temperature: { value: 19.0, unit: "degreeCelsius" } } },
])
```

For appending to a single object, or for unit handling and reading history, see
[Telemetry](./telemetry.md).

## Related

- [Objects overview](./overview.md)
- [Querying](./querying.md) — filters, search, link traversal, aggregation
- [Telemetry](./telemetry.md) — time-series property values
- [Actions](../actions/overview.md) — requesting commands against objects
- [HTTP reference](./http-reference.md) — the same operations over HTTP
