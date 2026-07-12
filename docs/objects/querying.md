# Querying Objects

Read objects from the latest-state graph: filter by properties, search text, sort, follow
links, and page through results. Reach for a query when you need graph-aware reads; use
[`get(id)`](crud.md) when you already know the primary id.

```ts
const { objects } = await sixb
  .objects(Project)
  .query()
  .where((project) => project.p.status.eq("active"))
  .orderBy(Project.p.deadline, "asc")
  .limit(25)
  .list()
```

`objects(Project).query()` starts from every `Project` and returns a builder. Each chained
method narrows or reshapes the current object set; a terminal method runs it. A property is
only filterable, sortable, searchable, or facetable if it declares that
[query metadata](../ontology/search-metadata.md).

## Terminal Methods

| Method | Returns | Use for |
| --- | --- | --- |
| `list(options?)` | `{ objects, total, hasMore, nextPageToken? }` | Reading rows, with pagination. |
| `first()` | one object or `null` | When one result is enough. |
| `count()` | `number` | A count without fetching rows. |
| `exists()` | `boolean` | An existence probe that stops at the first match. |
| `facets(inputs)` | bucketed counts | Aggregating a matching set by category. |

### list

`list()` returns object rows plus pagination metadata:

```ts
const { objects, total, hasMore } = await sixb
  .objects(Invoice)
  .query()
  .where((invoice) =>
    invoice.and(
      invoice.p.status.eq("overdue"),
      invoice.p.amount.gte(10_000)
    )
  )
  .orderBy(Invoice.p.dueDate, "asc")
  .limit(20)
  .list()

for (const invoice of objects) {
  console.log(invoice.primaryId, invoice.properties.number)
}
```

Each row has `primaryId`, `objectTypeId`, `properties`, `createdAt`, and `updatedAt`. With
the typed API, `properties` is inferred from the object type.

`total` is computed by default. Infinite-scroll UIs can skip the count query and keep only
page state:

```ts
const page = await sixb
  .objects(Invoice)
  .query()
  .orderBy(Invoice.p.dueDate, "asc")
  .page({ pageSize: 50, pageToken })
  .list({ includeTotal: false })

console.log(page.objects, page.hasMore, page.nextPageToken)
```

### count and exists

`count()` runs a count-only query and `exists()` stops after the first match. Neither
hydrates rows.

```ts
const overdueCount = await sixb
  .objects(Invoice)
  .query()
  .where((invoice) => invoice.p.status.eq("overdue"))
  .count()
```

### facets

`facets()` returns counts grouped by category. Bucket limits are required, and each facet
property must set `query.searchable: true` and `query.facet: true`.

```ts
const facets = await sixb
  .objects(Invoice)
  .query()
  .where((invoice) => invoice.p.status.in(["sent", "overdue"]))
  .facets([{ property: Invoice.p.status, limit: 10 }])

console.log(facets[0]?.buckets)
// [{ value: "sent", count: 42 }, { value: "overdue", count: 9 }]
```

Facets aggregate over the whole matching set, so row-shaping nodes such as `limit`, `page`,
and `orderBy` do not restrict facet counts.

## Predicates

Inside `where(...)`, `builder.p` exposes one typed predicate builder per property.

| Method | Meaning |
| --- | --- |
| `p.status.eq("paid")` / `neq("paid")` | Exact equality / inequality. |
| `p.amount.lt(n)` / `lte` / `gt` / `gte` | Ordered comparisons. |
| `p.status.in(["sent", "overdue"])` | Value is in a list. |
| `p.dueDate.exists()` / `exists(false)` | Property is present / missing. |
| `p.number.contains("INV")` | Substring (string), element (array), or key (map) match. |

Predicate values are checked against the property schema. Every predicate requires
`query.searchable: true` and `query.filterable: true` on the property (the primary id is
exempt for `eq` and `in`). Ordered comparisons additionally require an orderable schema: strings,
numbers, dates, timestamps, uuids, and enums.

### Combining with and / or / not

```ts
const invoices = await sixb
  .objects(Invoice)
  .query()
  .where((invoice) =>
    invoice.and(
      invoice.p.status.in(["sent", "overdue"]),
      invoice.or(
        invoice.p.currency.eq("EUR"),
        invoice.p.currency.eq("USD")
      ),
      invoice.not(invoice.p.amount.lt(1_000))
    )
  )
  .limit(10)
  .list()
```

Returning an array from `where(...)` is shorthand for an `and` group:

```ts
.where((invoice) => [
  invoice.p.status.eq("overdue"),
  invoice.p.amount.gte(100_000),
])
```

## Null and Missing Values

Sixb distinguishes an explicit JSON `null` from a missing property.

| Predicate | Matches `null` | Matches missing |
| --- | --- | --- |
| `p.dueDate.eq(null)` | yes | no |
| `p.dueDate.neq(null)` | no | yes |
| `p.dueDate.exists()` | yes | no |
| `p.dueDate.exists(false)` | no | yes |
| `p.dueDate.neq(someDate)` | yes | yes |
| `not(p.dueDate.eq(someDate))` | yes | yes |

Ordered comparisons (`lt`, `lte`, `gt`, `gte`) never match null or missing values. Sorting
places null or missing values last in both directions.

To require a present, non-null value before applying another check, combine predicates:

```ts
.where((invoice) =>
  invoice.and(
    invoice.p.dueDate.exists(),
    invoice.p.dueDate.neq(null),
    invoice.p.dueDate.lt(new Date())
  )
)
```

## Text Search

`search(...)` queries the object type's `search.defaultText` fields. Use it for substring
and full-text matching on text-enabled fields.

```ts
const customers = await sixb
  .objects(Customer)
  .query()
  .search("acme industries")
  .limit(10)
  .list()
```

Target specific text-enabled fields with property tokens:

```ts
.search("acme", { fields: [Customer.p.company, Customer.p.name] })
```

Terms are whitespace-tokenized. Portable text search treats every term as a required match
across the selected fields.

### Relevance

Providers with ranking support can order by relevance instead of a property:

```ts
const ranked = await sixb
  .objects(Customer)
  .query()
  .search("acme industries")
  .orderByRelevance("desc")
  .limit(10)
  .list()
```

If the storage provider does not support relevance sorting, the query is rejected at
execution with a structured planning error. Use `orderBy(...)` for portable, deterministic
ordering.

## Traversing Links

`traverse(...)` follows an ontology link and switches the result type to the linked object
type. Subsequent `where(...)` calls then use the target type's properties.

Outgoing traversal starts from the source object and follows one of its links:

```ts
const customer = await sixb
  .objects(Invoice)
  .query()
  .where((invoice) => invoice.p.id.eq("inv-001"))
  .traverse(Invoice.l.customer)
  .first()
```

Incoming traversal starts from the target and finds the sources that point to it:

```ts
const openInvoices = await sixb
  .objects(Customer)
  .query()
  .where((customer) => customer.p.id.eq("cust-001"))
  .traverse(Invoice.l.customer, { direction: "incoming" })
  .where((invoice) => invoice.p.status.in(["sent", "overdue"]))
  .orderBy(Invoice.p.dueDate, "asc")
  .list()
```

Several object types can declare a link with the same id — `Invoice.customer` and
`Project.customer`, for example. The fluent API pins incoming traversal to the link token's
owner type, so `traverse(Invoice.l.customer, { direction: "incoming" })` returns only
invoices. Wildcard links cannot be traversed through the fluent API, since the result type
cannot be inferred. See [links](../ontology/links.md).

## Expanding Links

`expand(...)` also follows a link, but unlike `traverse` it **keeps the current result type** and
attaches the linked objects to each row under `.links`. Reach for it when you want an object
*together with* its related objects in one query — an invoice with its customer, a customer with
its recent invoices — instead of switching the result to the target type.

```ts
const invoices = await sixb
  .objects(Invoice)
  .query()
  .where((invoice) => invoice.p.status.eq("overdue"))
  .expand(Invoice.l.customer)
  .list()

const customer = invoices[0]?.links.customer // Customer | null
```

Each `expand` widens the row, keyed by link id under `.links`: a `"one"` link adds `Target | null`,
a `"many"` link adds `Target[]`. Expanded targets expose their `.properties`, any edge
`linkProperties`, and their own nested `.links`. Nest a callback to expand deeper hops:

```ts
const rows = await sixb
  .objects(Invoice)
  .query()
  .expand(Invoice.l.customer, (customer) => customer.expand(Customer.l.region))
  .list()

const region = rows[0]?.links.customer?.links.region
```

For a `"many"` link, bound the fan-out to the top-N target objects per parent with `{ limit,
orderBy }` (options and a nested callback combine as `expand(link, { limit }, (child) => …)`):

```ts
.expand(Customer.l.invoices, {
  limit: 5,
  orderBy: [{ property: Invoice.p.dueDate, direction: "asc" }],
})
```

On PostgreSQL a uniform expansion is pushed down into a single query; other providers resolve it in
the runtime. Target types stay precise when the link uses direct object targets or resolves through
the [type manifest](../client/typed-queries.md), and otherwise degrade to a loose base shape. The
same builder works over HTTP from `@sixb/client` — see [typed queries](../client/typed-queries.md).

## Sorting and Limits

`orderBy(propertyToken, direction)` gives deterministic ordering. Chain calls for
tie-breaking:

```ts
const soonest = await sixb
  .objects(Invoice)
  .query()
  .where((invoice) => invoice.p.status.eq("overdue"))
  .orderBy(Invoice.p.dueDate, "asc")
  .orderBy(Invoice.p.amount, "desc")
  .limit(5)
  .list()
```

Add `limit(...)` to any query that could return many objects. Some providers run unbounded
queries, but bounded queries are safer and easier to reason about across storage adapters.

## Validate and Explain

`validate()` checks a query against the registered ontology without executing it.

```ts
const query = sixb
  .objects(Invoice)
  .query()
  .where((invoice) => invoice.p.status.eq("overdue"))
  .limit(10)

const validation = query.validate()
console.log(validation.result.objectTypeIds)
```

`explain()` returns a structured explanation tree; `formatExplanation()` renders it as text
for logs or tests:

```ts
console.log(query.formatExplanation())
```

Validation catches unknown properties, wrong value types, missing query metadata, invalid
text fields, and unsupported traversal shapes. Provider-capability issues — unsupported
relevance sorting or vector search — surface only when the query runs through a terminal
method or the HTTP route.

## Related

- [Search metadata](../ontology/search-metadata.md) — making fields filterable, sortable,
  text-searchable, and facetable.
- [Typed queries in the browser](../client/typed-queries.md) — the same builder via
  `@sixb/client/query` and TanStack Query hooks.
- [HTTP reference](http-reference.md) — raw query JSON for `POST /api/objects/query`.
