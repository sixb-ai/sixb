# Objects

`sixb.objects(Type)` is the typed runtime API for reading and writing object
instances: create/update, fetch by id, query the latest-state graph, follow
links, append telemetry, and request actions. It is the main surface most
application code uses to talk to your data.

Object *types* are declared in the ontology (see [object types](../ontology/object-types.md)).
This section covers the runtime API you use to operate on the *instances* of
those types.

## Mental Model

An object is the current state of one business entity — one `Customer`, one
`Invoice`, one `Device` — keyed by its primary property. Calling
`sixb.objects(MyType)` returns an `ObjectSet`: a type-safe collection bound to
that object type whose method signatures are inferred from the ontology
definition.

From an `ObjectSet` you reach three things:

| Entry point | Returns | Use for |
| --- | --- | --- |
| collection methods | the set itself | `upsert`, `get`, `list`, batch telemetry, set-level link/action helpers |
| `.query()` | a query builder | graph-aware reads: filter, search, sort, follow links, page |
| `.byId(id)` | an object handle | operations bound to one instance: links, telemetry, actions |

```ts
const customers = sixb.objects(Customer)

const customer = await customers.get("cust-001")
const handle = customers.byId("cust-001")
```

## API Surface

### Collection methods

Called directly on `sixb.objects(Type)`.

| Method | Signature | Notes |
| --- | --- | --- |
| `upsert` | `upsert({ properties }) => TwinObject` | Create or replace by primary id. The primary property must be present in `properties`. |
| `get` | `get(id) => TwinObject \| null` | Fetch one object by primary id. |
| `list` | `list(input?) => { objects, hasMore, total }` | Storage browse by id prefix/suffix, timestamps, with `limit`/`offset`/`orderBy`/`order`. |
| `query` | `query() => QueryBuilder` | Start a graph-aware query. See [querying](./querying.md). |
| `byId` | `byId(id) => ObjectByIdHandle` | Bind operations to one instance. |
| `appendTelemetryBatch` | `appendTelemetryBatch(items) => void` | Append telemetry across many objects in one call. See [telemetry](./telemetry.md). |
| `upsertLink` | `upsertLink({ sourceId, linkId, targetTypeId, targetId, properties? }) => void` | Create/update a link by string ids. |
| `removeLink` | `removeLink({ sourceId, linkId, targetTypeId, targetId }) => void` | Remove a link by string ids. |
| `requestAction` | `requestAction({ id, action? \| actionId, params?, runId? }) => …` | Request an action against one object. |
| `requestActionAndWait` | `requestActionAndWait({ id, action? \| actionId, params?, timeoutMs?, signal? }) => …` | Request and await the action run. |

```ts
const customers = sixb.objects(Customer)

// Create or update by primary id
await customers.upsert({
  properties: { id: "cust-001", name: "Acme Corp", tier: "business" },
})

// Read one
const found = await customers.get("cust-001")

// Browse by type
const page = await customers.list({ limit: 25, orderBy: "updatedAt", order: "desc" })
```

### `.byId(id)` handle

`byId(id)` returns an `ObjectByIdHandle` whose operations are all scoped to that
single object.

| Method | Signature | Notes |
| --- | --- | --- |
| `get` | `get() => TwinObject \| null` | Fetch this object. |
| `link` | `link(linkToken, target, options?) => void` | Add a link using a typed token (`Type.l.<name>`). |
| `unlink` | `unlink(linkToken, target) => void` | Remove a link. |
| `listLinks` | `listLinks(linkToken?) => links` | List this object's links, optionally for one link token. |
| `telemetry` | `telemetry(propertyToken) => { append }` | Per-property telemetry appender with unit/value validation. |
| `requestAction` | `requestAction({ action? \| actionId, params?, runId? }) => …` | Request an action on this object. |
| `requestActionAndWait` | `requestActionAndWait({ action? \| actionId, params?, timeoutMs?, signal? }) => …` | Request and await the run. |

```ts
const handle = sixb.objects(Customer).byId("cust-001")

// Link using a typed link token
await handle.link(Customer.l.belongsTo, {
  objectTypeId: "Organization",
  primaryId: "org-1",
})

// Append telemetry for one property
await handle.telemetry(Customer.p.temperature).append({
  value: 21.5,
  unit: "degreeCelsius",
  at: new Date(),
})

// Request an action
await handle.requestAction({
  actionId: "issueCredit",
  params: { amount: 500 },
})
```

## Links

Links connect objects in the latest-state graph. Define them on an object type
with `link(...)` (see [links](../ontology/links.md)), then operate on them at
runtime two ways:

- **Typed tokens** via the handle: `byId(id).link(Type.l.<name>, target)`,
  `unlink(...)`, and `listLinks(...)`. The token is checked at compile time
  against the source object type.
- **String ids** via the set: `upsertLink({ ... })` and `removeLink({ ... })`
  when you only have raw ids.

```ts
const customers = sixb.objects(Customer)

// Typed token form
await customers.byId("cust-001").link(Customer.l.belongsTo, {
  objectTypeId: "Organization",
  primaryId: "org-1",
})

// String-id form
await customers.upsertLink({
  sourceId: "cust-001",
  linkId: "belongsTo",
  targetTypeId: "Organization",
  targetId: "org-1",
})
```

Query across links with the query builder (`.where(...)` over linked types,
link traversal), and read link rows with `byId(id).listLinks(...)`. Links are
also exposed over HTTP — see the [HTTP reference](./http-reference.md).

## Footgun: runtime `objects()` vs action `objects()`

Two different `objects(Type)` APIs exist and they look almost identical. Picking
the wrong one is the most common mistake.

| | `sixb.objects(Type)` (runtime) | `objects(Type)` (action `.edits()`) |
| --- | --- | --- |
| Where | functions, syncs, schedules, app code | inside an action's `.edits(...)` handler |
| Timing | **async, immediate** — writes apply now | **sync, staged** — recorded into an EditBatch, applied atomically on commit |
| `await` | every method returns a promise | edit calls are synchronous, no `await` |
| Create | `upsert({ properties })` | `create(properties)` |
| Update | `upsert(...)` (full replace) | `byId(id).update({ ... })` |
| Reads | `get` / `query` / `list` | use `read.objects(Type)` for reads |

Runtime — async and immediate:

```ts
// in a function or sync
await sixb.objects(Invoice).upsert({
  properties: { id: "inv-1", status: "sent" },
})
```

Action `.edits()` — synchronous and staged:

```ts
// inside defineAction(...).edits(async ({ objects, read, subject }) => { … })
const invoice = await read.objects(Invoice).get(subject.primaryId)

objects(Invoice).byId(subject.primaryId).update({
  status: "sent",
})
// no await: the update is staged and committed atomically after the handler returns
```

Rule of thumb: if you wrote `sixb.objects(...)` you are in the runtime API. If
you destructured `objects` (and `read`) from an action handler argument, you are
staging edits. See [actions](../actions/overview.md) for the EditBatch model.

## In This Section

- [CRUD](./crud.md) — create, read, update, delete with `upsert`/`get`/`list`.
- [Querying](./querying.md) — filter, search, sort, follow links, and page.
- [Telemetry](./telemetry.md) — append and read per-property timeseries.
- [HTTP reference](./http-reference.md) — the REST/WebSocket surface for objects and links.

## Related

- [Object types](../ontology/object-types.md) — declaring the types these APIs operate on.
- [Links](../ontology/links.md) — modeling relationships.
- [Actions](../actions/overview.md) — staged edits and writebacks.
- [Events](../events/overview.md) — `object.upserted`, `telemetry.appended`, `link.upserted`, `link.removed`.
