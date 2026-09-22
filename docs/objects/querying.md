# Querying

Queries filter, search, and follow relationships between objects. Start with
`sixb.objects(Type).query()`, then call `list()`, `first()`, `count()`, or `exists()` to read results.
For an object whose ID you already know, use [`get()`](overview.md#read-an-object).

The same query methods are available in [React apps](../apps/querying-data.md).

## Filter objects

Use `where()` to filter by property values. Filtered properties must declare
`query: { searchable: true, filterable: true }` in the ontology. See
[property query metadata](../ontology/properties.md#enable-queries).

```ts
import { Invoice } from "./ontology/invoice"

const { objects } = await sixb
  .objects(Invoice)
  .query()
  .where((invoice) => invoice.p.status.eq("overdue"))
  .limit(25)
  .list()

for (const invoice of objects) {
  console.log(invoice.properties.number)
}
```

`list()` returns `{ objects, total, hasMore, nextPageToken? }`. Use `first()` to return one object
or `null` instead.

| Predicate | Matches |
| --- | --- |
| `p.status.eq("paid")` / `neq("paid")` | Equal / unequal values. |
| `p.amount.lt(100)` / `lte` / `gt` / `gte` | Ordered comparisons. |
| `p.status.in(["sent", "overdue"])` | Any value in the list. |
| `p.dueDate.exists()` / `exists(false)` | Present / missing properties. |
| `p.number.contains("INV")` | A substring; also works for array elements and map keys. |

Primary-ID comparisons with `eq` or `in` do not need query metadata.

Return an array to require all conditions. Use `or(...)` for alternatives and `not(...)` to negate
one condition:

```ts
.where((invoice) => [
  invoice.p.status.eq("overdue"),
  invoice.or(invoice.p.currency.eq("EUR"), invoice.p.currency.eq("USD")),
  invoice.not(invoice.p.amount.lt(1_000)),
])
```

A present `null` differs from a missing property: `exists()` includes `null`, while `eq(null)`
matches only explicit nulls. `neq(...)` also matches missing properties. Ordered comparisons
exclude both null and missing values.

## Search text

`search()` searches the object's `search.defaultText` fields. Each field needs
`query: { searchable: true, text: true }`:

```ts
import { Customer } from "./ontology/customer"

const { objects: customers } = await sixb
  .objects(Customer)
  .query()
  .search("acme industries")
  .limit(10)
  .list()
```

Pass `fields` to search specific text-enabled properties:

```ts
.search("acme", { fields: [Customer.p.company, Customer.p.name] })
```

Each search term must match somewhere in the selected fields. To sort by relevance, add
`orderByRelevance("desc")`; this requires a storage provider that supports ranking.

## Search by meaning

Use `vector()` with a [named profile](../ontology/properties.md#configure-vector-search) and search
text. Sixb embeds the text on the server and returns the nearest authorized objects:

```ts
import { Product } from "./ontology/product"

const { objects: products } = await sixb
  .objects(Product)
  .query()
  .vector("content", "lightweight running shoes", { k: 10 })
  .list()
```

Results are ordered by similarity, highest first, with a `score` on each object. `k` accepts
1–1,000. Search text must be nonempty and at most 8,000 characters. The same call works with
`objects(Product)` in [React apps](../apps/querying-data.md).

Projections generate and refresh embeddings in the background. Objects become searchable once
their embeddings are ready. To index an existing object after adding or changing a profile, or
to explicitly retry indexing, call this from an action's writeback/effects handler or a workflow step:

```ts
await sixb.objects(Product).byId("product-1").vector("content").index()
```

Changing a profile does not automatically reindex existing objects. Source changes invalidate
stale embeddings so searches do not use out-of-date content. Indexing requires edit access to
the object. Both indexing and search require read access to every source property in the profile.

Vector queries use one profile and one concrete object type. Apply `where()` before `vector()`
to narrow candidates. Pagination, traversal, expansion, and combining keyword and vector search
are not supported. Counts and facets describe the selected top `k` results.

Storage must support vector search. See [PostgreSQL setup](https://github.com/sixb-ai/sixb/tree/main/storage/pg#vector-profiles)
or [SQLite setup](https://github.com/sixb-ai/sixb/tree/main/storage/sqlite#vector-profiles), including
SQLite's macOS requirements. SQL search has candidate limits; narrow filters if you reach them.
Indexing and each search call count toward [AI usage and limits](../models/usage-and-limits.md#embeddings).

## Sort and paginate

Use `orderBy()` to sort and `limit()` to cap the result count. Sorted properties need
`query: { searchable: true, sortable: true }`. Chain `orderBy()` calls to break ties:

```ts
const { objects } = await sixb
  .objects(Invoice)
  .query()
  .orderBy(Invoice.p.dueDate, "asc")
  .orderBy(Invoice.p.amount, "desc")
  .limit(25)
  .list()
```

Null and missing values sort last in both directions.

For multiple pages, pass the previous result's `nextPageToken` to `page()`. Keep the query and page
size the same between requests. Use `includeTotal: false` when you do not need a total count:

```ts
const query = sixb.objects(Invoice).query().orderBy(Invoice.p.dueDate, "asc")

const firstPage = await query.page({ pageSize: 25 }).list({ includeTotal: false })

if (firstPage.hasMore) {
  const nextPage = await query
    .page({ pageSize: 25, pageToken: firstPage.nextPageToken })
    .list({ includeTotal: false })
}
```

## Follow relationships

`traverse()` follows a link and returns the related objects. This query starts from an invoice
and returns its customer:

```ts
const customer = await sixb
  .objects(Invoice)
  .query()
  .where((invoice) => invoice.p.id.eq("inv-001"))
  .traverse(Invoice.l.customer)
  .first()
```

Use `direction: "incoming"` to follow a link in reverse. After traversal, filters and sorting apply
to the new result type:

```ts
const { objects: openInvoices } = await sixb
  .objects(Customer)
  .query()
  .where((customer) => customer.p.id.eq("cust-001"))
  .traverse(Invoice.l.customer, { direction: "incoming" })
  .where((invoice) => invoice.p.status.in(["sent", "overdue"]))
  .limit(25)
  .list()
```

The token identifies which relationship to follow. Use a link with a single target type for
outgoing typed traversal; wildcard links cannot be traversed with this builder.

## Include related objects

`expand()` keeps the objects you queried and includes related objects under `.links`.
A `"one"` link returns one object or `null`; a `"many"` link returns an array:

```ts
const { objects: invoices } = await sixb
  .objects(Invoice)
  .query()
  .where((invoice) => invoice.p.status.eq("overdue"))
  .expand(Invoice.l.customer)
  .limit(25)
  .list()

const customer = invoices[0]?.links.customer
console.log(customer?.properties.name)
```

Nest a callback to include another level of relationships:

```ts
.expand(Invoice.l.customer, (customer) => customer.expand(Customer.l.region))
```

For a `"many"` link, limit and sort the related objects returned for each parent:

```ts
.expand(Customer.l.invoices, {
  limit: 5,
  orderBy: [{ property: Invoice.p.dueDate, direction: "asc" }],
})
```

Relationship properties, when present, are available as `linkProperties` on the related object.

## Count and group results

Use `count()` for the number of matches and `exists()` to check whether any match:

```ts
const overdue = sixb
  .objects(Invoice)
  .query()
  .where((invoice) => invoice.p.status.eq("overdue"))

const count = await overdue.count()
const hasOverdueInvoices = await overdue.exists()
```

`facets()` groups counts by a property. The property needs
`query: { searchable: true, facet: true }`, and each facet requires a bucket limit:

```ts
const facets = await sixb
  .objects(Invoice)
  .query()
  .facets([{ property: Invoice.p.status, limit: 10 }])

console.log(facets[0]?.buckets)
// [{ value: "paid", count: 42 }, { value: "overdue", count: 9 }]
```

Facets count the whole matching set. Row limits and pagination do not restrict their counts;
vector queries count only their selected top `k` results.
