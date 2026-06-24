# Querying Objects

Object queries read objects from the latest-state graph: filter by properties, search text,
sort, follow links, and page through results.

Most application code starts from the typed runtime API:

```ts
const result = await sixb
  .objects(Project)
  .query()
  .where((project) => project.p.status.eq("active"))
  .orderBy(Project.p.deadline, "asc")
  .limit(25)
  .list()
```

Use a query when you need graph-aware reads. Use [`get(id)`](crud.md) when you know the
primary id. Properties are only queryable when you declare query metadata on them — see
[search metadata](../ontology/search-metadata.md).

## Basic Queries

`sixb.objects(Project).query()` starts with every `Project` object and returns a builder.
Each chained method narrows or reshapes the current object set.

### list

`list()` returns full object rows plus pagination metadata:

```ts
const { objects, total, hasMore } = await sixb
  .objects(Project)
  .query()
  .where((project) =>
    project.and(
      project.p.status.eq("active"),
      project.p.budget.gte(50_000),
      project.p.deadline.lte(new Date("2026-12-31"))
    )
  )
  .orderBy(Project.p.deadline, "asc")
  .limit(20)
  .list()

for (const project of objects) {
  console.log(project.primaryId, project.properties.name)
}
```

```ts
type ObjectQueryListResult<T> = {
  objects: T[]
  hasMore: boolean
  nextPageToken?: string
  total: number
}
```

Each object has `primaryId`, `objectTypeId`, `properties`, `createdAt`, and `updatedAt`.
With the typed API, `properties` is inferred from the object type.

Totals are included by default. Infinite-scroll UIs can skip the count query and keep only
page state:

```ts
const page = await sixb
  .objects(Project)
  .query()
  .orderBy(Project.p.deadline, "asc")
  .page({ pageSize: 50, pageToken })
  .list({ includeTotal: false })

console.log(page.objects, page.hasMore, page.nextPageToken)
```

### first

`first()` returns one object when that is all you need:

```ts
const project = await sixb
  .objects(Project)
  .query()
  .where((project) => project.p.id.eq("proj-001"))
  .first()
```

### count

`count()` runs a count-only storage query for providers that support object-query pushdown.
It does not fetch or hydrate object rows.

```ts
const activeProjectCount = await sixb
  .objects(Project)
  .query()
  .where((project) => project.p.status.eq("active"))
  .count()
```

### exists

`exists()` runs an existence probe that stops after the first matching object.

```ts
const hasLiveProjects = await sixb
  .objects(Project)
  .query()
  .where((project) => project.p.status.eq("active"))
  .exists()
```

### facets

`facets()` returns counts grouped by category:

```ts
const facets = await sixb
  .objects(Project)
  .query()
  .where((project) => project.p.status.in(["active", "paused"]))
  .facets([{ property: Project.p.status, limit: 10 }])

console.log(facets[0]?.buckets)
// [{ value: "active", count: 12 }, { value: "paused", count: 3 }]
```

Facet properties must set `query.searchable: true` and `query.facet: true`. Bucket limits
are required. Facets answer aggregate questions over the matching set, so outer row-shaping
nodes such as `limit`, `page`, and `orderBy` do not restrict facet counts.

## Predicates

Inside `where(...)`, `builder.p` exposes one typed predicate builder per property.

| Method | Meaning |
| --- | --- |
| `p.status.eq("active")` | Exact equality. |
| `p.status.neq("cancelled")` | Exact inequality. |
| `p.budget.lt(10000)` / `lte` / `gt` / `gte` | Ordered comparisons. |
| `p.status.in(["active", "paused"])` | Value is in a list. |
| `p.deadline.exists()` | Property is present. |
| `p.deadline.exists(false)` | Property is missing. |
| `p.name.contains("Acme")` | String substring match. |
| `p.tags.contains("urgent")` | Array contains an item. |
| `p.metadata.contains("region")` | Map contains a key. |

Predicate values are checked against the property schema. Range predicates and sorting work
on orderable schemas: strings, numbers, dates, timestamps, uuids, and enums.

### Combining With and / or / not

```ts
const projects = await sixb
  .objects(Project)
  .query()
  .where((project) =>
    project.and(
      project.p.status.in(["active", "paused"]),
      project.or(
        project.p.name.contains("dashboard"),
        project.p.description.contains("dashboard")
      ),
      project.not(project.p.status.eq("cancelled"))
    )
  )
  .limit(10)
  .list()
```

Returning an array from `where(...)` is treated as an `and` group:

```ts
const activeLargeProjects = await sixb
  .objects(Project)
  .query()
  .where((project) => [
    project.p.status.eq("active"),
    project.p.budget.gte(100_000),
  ])
  .list()
```

## Null And Missing Values

Sixb distinguishes an explicit JSON `null` from a missing property.

| Predicate | Matches explicit `null` | Matches missing field |
| --- | --- | --- |
| `p.phase.eq(null)` | yes | no |
| `p.phase.neq(null)` | no | yes |
| `p.phase.exists()` | yes | no |
| `p.phase.exists(false)` | no | yes |
| `p.phase.neq("draft")` | yes | yes |
| `not(p.phase.eq("draft"))` | yes | yes |

Ordered comparisons (`lt`, `lte`, `gt`, `gte`) do not match null or missing values. Sorting
places null or missing sort values after present values in both ascending and descending
order.

To require a present, non-null field before applying another predicate, combine checks:

```ts
const projectsWithKnownNonDraftPhase = await sixb
  .objects(Project)
  .query()
  .where((project) =>
    project.and(
      project.p.phase.exists(),
      project.p.phase.neq(null),
      project.p.phase.neq("draft")
    )
  )
  .list()
```

## Text Search

Text search uses `search.defaultText` by default.

```ts
const projects = await sixb
  .objects(Project)
  .query()
  .search("energy dashboard")
  .limit(10)
  .list()
```

Search specific text-enabled fields with property tokens:

```ts
const projects = await sixb
  .objects(Project)
  .query()
  .search("energy dashboard", { fields: [Project.p.name, Project.p.description] })
  .limit(10)
  .list()
```

Search terms are whitespace-tokenized. Portable text search treats all terms as required
matches across the selected fields.

### Relevance

Providers with ranking support can use field weights and relevance ordering:

```ts
const ranked = await sixb
  .objects(Project)
  .query()
  .search("energy dashboard")
  .orderByRelevance("desc")
  .limit(10)
  .list()
```

If the configured storage provider does not support relevance sorting, the query is rejected
with a structured planning error. Use `orderBy(...)` for portable deterministic ordering.

## Traversing Links

`traverse(...)` follows ontology links and changes the current result type to the linked
object type.

Outgoing traversal starts from the source object and follows one of its links:

```ts
const customer = await sixb
  .objects(Project)
  .query()
  .where((project) => project.p.id.eq("proj-001"))
  .traverse(Project.l.customer)
  .first()
```

Incoming traversal starts from the target object and finds source objects that point to it:

```ts
const customerProjects = await sixb
  .objects(Customer)
  .query()
  .where((customer) => customer.p.id.eq("cust-001"))
  .traverse(Project.l.customer, { direction: "incoming" })
  .where((project) => project.p.status.eq("active"))
  .orderBy(Project.p.deadline, "asc")
  .list()
```

Traversal is type-aware. After `traverse(Project.l.customer)`, subsequent `where(...)` calls
use the target object's properties. Wildcard links cannot be traversed through the fluent
API because the result object type cannot be inferred.

Several object types can declare a link with the same id — for example `Project.customer`
and `Invoice.customer`. The fluent API always pins incoming traversal to the link token's
owner type, so `traverse(Project.l.customer, { direction: "incoming" })` returns only
projects. See [links](../ontology/links.md) for how links are declared.

## Sorting And Limits

Use `orderBy(propertyToken, direction)` for deterministic ordering. Chain multiple calls for
tie-breaking:

```ts
const soonest = await sixb
  .objects(Project)
  .query()
  .where((project) => project.p.status.eq("active"))
  .orderBy(Project.p.deadline, "asc")
  .orderBy(Project.p.budget, "desc")
  .limit(5)
  .list()
```

Use `limit(...)` on any query that could return many objects. Some providers can execute
unbounded queries, but bounded queries are easier to reason about and safer across storage
adapters.

## Validate And Explain

`validate()` checks the query against the registered ontology without executing it.

```ts
const query = sixb
  .objects(Project)
  .query()
  .where((project) => project.p.status.eq("active"))
  .search("dashboard")
  .limit(10)

const validation = query.validate()
console.log(validation.result.objectTypeIds)
```

`explain()` returns a structured explanation tree. `formatExplanation()` is useful in logs
or tests.

```ts
console.log(query.formatExplanation())
```

Validation catches problems such as unknown properties, wrong value types, missing query
metadata, invalid text fields, and unsupported link traversal shapes. Provider capability
issues, such as unsupported relevance sorting or vector search, are reported when the query
executes through `.list()`, `.count()`, `.exists()`, `.facets()`, `.first()`, or the HTTP
route.

## Related

- [Search metadata](../ontology/search-metadata.md) — making fields filterable, sortable,
  text-searchable, and facetable.
- [Typed queries in the browser](../client/typed-queries.md) — the same fluent builder via
  `@sixb/client/query` and TanStack Query hooks.
- [HTTP reference](http-reference.md) — raw query JSON for `POST /api/objects/query` and the
  count, exists, and facets routes.
