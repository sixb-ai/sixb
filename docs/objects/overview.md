# Objects

An object represents one thing in your domain, such as a customer, invoice, or project.
Use `sixb.objects(Type)` to read and update objects with types inferred from your
[ontology](../ontology/object-types.md).

These examples run in backend code. For React apps, see [Querying data in apps](../apps/querying-data.md).

## Read an object

Pass the object's primary ID to `get()`. It returns the object, or `null` if it does not exist.
Property values are available under `.properties`:

```ts
import { Invoice } from "./ontology/invoice"

const invoices = sixb.objects(Invoice)
const invoice = await invoices.get("inv-001")

if (invoice) {
  console.log(invoice.properties.amount, invoice.properties.status)
}
```

The returned object also includes `primaryId`, `objectTypeId`, and `createdAt` and `updatedAt`
as `Date` values.

## Create or update an object

`upsert()` creates an object or updates the one with the same primary ID. Include the primary
property inside `properties`, along with all required properties when creating an object:

```ts
await invoices.upsert({
  properties: {
    id: "inv-001",
    number: "INV-2026-001",
    amount: 4800,
    currency: "EUR",
    status: "sent",
  },
})
```

To update an existing object, pass only the primary ID and the properties to change.
Omitted properties keep their values:

```ts
await invoices.upsert({
  properties: { id: "inv-001", status: "paid" },
})
```

Inside an [action's `.edits()` handler](../actions/overview.md), use its `objects` helper to stage
changes instead. Those edits are synchronous and commit together when the handler succeeds.

## List objects

Use `list()` to browse objects by ID or creation/update time. Set `limit` and `offset` to page
through the results:

```ts
const { objects, hasMore, total } = await invoices.list({
  orderBy: "updatedAt",
  order: "desc",
  limit: 25,
  offset: 0,
})
```

`objects` contains the current page, `hasMore` indicates another page, and `total` is the matching
count. Increase `offset` by `limit` to read the next page. For property filters, text search, or
related objects, use [queries](querying.md).

## Add or remove relationships

Use `byId()` to work with one object's [links](../ontology/links.md). Pass a link token and the
target object's type and primary ID:

```ts
import { Customer } from "./ontology/customer"

const invoice = invoices.byId("inv-001")
const customer = { objectTypeId: Customer.id, primaryId: "cust-001" }

await invoice.link(Invoice.l.customer, customer)

const links = await invoice.listLinks(Invoice.l.customer)

await invoice.unlink(Invoice.l.customer, customer)
```

For a link with cardinality `"one"`, remove the existing target before linking a different one.
Linking the same target updates the existing relationship. To replace a target atomically, use
[action edits](../actions/overview.md#edit-objects-and-relationships).

### Write relationship properties

Pass values through the link call's `properties` option. This example uses the
[`reviewers` relationship](../ontology/links.md#add-relationship-properties), which declares a required
`assignedAt` timestamp:

```ts
const reviewer = { objectTypeId: "Reviewer", primaryId: "reviewer-1" } as const

await invoices.byId("inv-001").link(Invoice.l.reviewers, reviewer, {
  properties: { assignedAt: new Date() },
})
```

Each call replaces the relationship's properties, so include required values every time.
Use `listLinks(Invoice.l.reviewers)` to read the relationship rows, or
[expand the link](querying.md#include-related-objects) to read the related objects with their
`linkProperties`.

## Delete and restore

`delete()` removes an object and its links. Deleting an object that does not exist has no effect:

```ts
await invoices.byId("inv-001").delete()
```

An object supplied by a projection stays hidden after deletion, even when the projection runs
again. Use `restore()` to reveal its projected state:

```ts
await invoices.byId("inv-001").restore()
```

For an object created only from code, deletion is permanent and `restore()` has no effect.
Use `upsert()` to create it again.

For commands against objects, see [Actions](../actions/overview.md). For values that change over
time, see [Telemetry](telemetry.md).
