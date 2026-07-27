# Objects

`sixb.objects(Type)` is the typed runtime API for reading and writing object
instances: create and update, fetch by id, query the latest-state graph, follow
links, append telemetry, and request actions. It is the main surface your
application code uses to talk to your data.

Object *types* are declared in the ontology (see
[object types](../ontology/object-types.md)). This page covers the runtime API
you use to operate on the *instances* of those types.

## Mental model

An object is the current state of one entity — one `Customer`, one `Invoice`,
one `Project` — keyed by its primary property. `sixb.objects(Type)` returns an
`ObjectSet`: a type-safe collection bound to that type, with signatures inferred
from the ontology definition.

From an `ObjectSet` you reach three things:

| Entry point | Returns | Use for |
| --- | --- | --- |
| collection methods | the set itself | `upsert`, `get`, `list`, batch telemetry, set-level link/action helpers |
| `.query()` | a query builder | graph-aware reads: filter, search, sort, follow links, page |
| `.byId(id)` | an object handle | operations on one instance: links, telemetry, actions |

```ts
const invoices = sixb.objects(Invoice)

const invoice = await invoices.get("inv-001")
const handle = invoices.byId("inv-001")
```

A fetched object is a `TwinObject`: read `.primaryId` and `.properties.<name>`.

## Collection methods

Called directly on `sixb.objects(Type)`. All methods are async — `await` them.

| Method | Signature | Notes |
| --- | --- | --- |
| `upsert` | `upsert({ properties }) => TwinObject` | Create or update by primary id — the given properties are merged over any existing ones. The primary property must be inside `properties`. |
| `get` | `get(id) => TwinObject \| null` | Fetch one object by primary id. |
| `list` | `list(input?) => { objects, hasMore, total }` | Browse by id prefix/suffix or timestamps, with `limit`/`offset`/`orderBy`/`order`. |
| `query` | `query() => QueryBuilder` | Start a graph-aware query. See [querying](./querying.md). |
| `byId` | `byId(id) => ObjectByIdHandle` | Bind operations to one instance. |
| `appendTelemetryBatch` | `appendTelemetryBatch(items) => void` | Append telemetry across many objects in one call. See [telemetry](./telemetry.md). |
| `upsertLink` | `upsertLink({ sourceId, linkId, targetTypeId, targetId, properties? }) => void` | Create or update a link by string ids. |
| `removeLink` | `removeLink({ sourceId, linkId, targetTypeId, targetId }) => void` | Remove a link by string ids. |
| `requestAction` | `requestAction({ id, actionId, params?, runId? }) => …` | Request an action against one object. |
| `requestActionAndWait` | `requestActionAndWait({ id, actionId, params?, timeoutMs?, signal? }) => …` | Request and await the run. |

```ts
const invoices = sixb.objects(Invoice)

// Create or update by primary id
await invoices.upsert({
  properties: { id: "inv-001", number: "2026-001", amount: 4200, currency: "EUR", status: "sent" },
})

// Read one
const invoice = await invoices.get("inv-001")

// Browse the type
const page = await invoices.list({ limit: 25, orderBy: "updatedAt", order: "desc" })
```

## `.byId(id)` handle

`byId(id)` returns an `ObjectByIdHandle` scoped to a single object.

| Method | Signature | Notes |
| --- | --- | --- |
| `get` | `get() => TwinObject \| null` | Fetch this object. |
| `link` | `link(token, target, options?) => void` | Add a link via a typed token (`Type.l.<name>`). |
| `unlink` | `unlink(token, target) => void` | Remove a link. |
| `listLinks` | `listLinks(token?) => links` | List this object's links, optionally for one token. |
| `telemetry` | `telemetry(token) => { append }` | Per-property telemetry appender (`Type.p.<name>`). |
| `requestAction` | `requestAction({ actionId, params?, runId? }) => …` | Request an action on this object. |
| `requestActionAndWait` | `requestActionAndWait({ actionId, params?, timeoutMs?, signal? }) => …` | Request and await the run. |

```ts
const handle = sixb.objects(Invoice).byId("inv-001")

// Append telemetry to a project's progress series
await sixb.objects(Project).byId("proj-001").telemetry(Project.p.progress).append({
  value: 60,
  at: new Date(),
})

// Request an action on the invoice
await handle.requestAction({
  actionId: "sendReminder",
})
```

## Links

Links connect objects in the latest-state graph. Define them on an object type
with `link(...)` (see [links](../ontology/links.md)), then operate on them at
runtime two ways:

- **Typed tokens** via the handle: `byId(id).link(Type.l.<name>, target)`,
  `unlink(...)`, and `listLinks(...)`. The token is checked at compile time
  against the source type.
- **String ids** via the set: `upsertLink({ ... })` and `removeLink({ ... })`
  when you only have raw ids.

```ts
const invoices = sixb.objects(Invoice)

// Typed token form
await invoices.byId("inv-001").link(Invoice.l.customer, {
  objectTypeId: "Customer",
  primaryId: "cust-001",
})

// String-id form
await invoices.upsertLink({
  sourceId: "inv-001",
  linkId: "customer",
  targetTypeId: "Customer",
  targetId: "cust-001",
})
```

Traverse links in reads with the [query builder](./querying.md), and read raw
link rows with `byId(id).listLinks(...)`. Links are also exposed over HTTP — see
the [HTTP reference](./http-reference.md).

## Footgun: runtime `objects()` vs action `objects()`

Two `objects(Type)` APIs look almost identical. Picking the wrong one is the
most common mistake.

| | `sixb.objects(Type)` (runtime) | `objects(Type)` (action `.edits()`) |
| --- | --- | --- |
| Where | workflow steps, syncs, scripts, app code | inside an action's `.edits(...)` handler |
| Timing | **async, immediate** — writes apply now | **sync, staged** — applied atomically on commit |
| `await` | every method returns a promise | edit calls are synchronous |
| Create | `upsert({ properties })` | `create(properties)` |
| Update | `upsert(...)` (merge over existing) | `byId(id).update({ ... })` |
| Reads | `get` / `query` / `list` | `read.objects(Type)` |

```ts
// Runtime — async, immediate
await sixb.objects(Invoice).upsert({
  properties: { id: "inv-001", status: "paid" },
})

// Action .edits() — synchronous, staged, no await
objects(Invoice).byId(subject.primaryId).update({ status: "paid" })
objects(Invoice).create({ id: params.id, status: "paid" })
```

Staged edits separate create from update. `create` requires that the object does
not already exist and `update` requires that it does, so an action that
synchronizes a record which may or may not exist has to read first and branch.
The runtime `upsert` is the create-or-update form.

If you wrote `sixb.objects(...)` you are in the runtime API. If you destructured
`objects` from an action handler argument, you are staging edits. See
[actions](../actions/overview.md) for the EditBatch model.

## In this section

- [CRUD](./crud.md) — create, read, update, delete with `upsert`/`get`/`list`.
- [Querying](./querying.md) — filter, search, sort, follow links, and page.
- [Telemetry](./telemetry.md) — append and read per-property timeseries.
- [HTTP reference](./http-reference.md) — the REST/WebSocket surface.

## Related

- [Object types](../ontology/object-types.md) — declaring the types these APIs operate on.
- [Links](../ontology/links.md) — modeling relationships.
- [Actions](../actions/overview.md) — staged edits and writebacks.
- [Events](../events/overview.md) — canonical object, telemetry, and link mutation events.
