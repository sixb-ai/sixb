# Object Query

Object queries read objects from the latest-state graph: filter by properties, search text,
sort, follow links, and page through results.

Most application code should start from the typed runtime API:

```ts
const result = await sixb
  .objects(Project)
  .query()
  .where((project) => project.p.status.eq("active"))
  .orderBy(Project.p.deadline, "asc")
  .limit(25)
  .list()
```

Use object query when you need graph-aware reads. Use `get(id)` when you know the primary
id, and use `list(...)` for simple storage browsing by object type, id prefix, timestamps,
or offset.


## Make Fields Queryable

Sixb validates queries against your ontology. Properties are not queryable just because they
exist; declare query metadata on fields you want to filter, sort, or search.

```ts
import { defineObjectType, link, prop, stringEnum } from "@sixb/core"
import { Customer } from "./customer"
import { Employee } from "./employee"

export const Project = defineObjectType({
  id: "Project",
  name: "Project",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", {
      required: true,
      query: { searchable: true, text: true, exact: true, sortable: true, weight: 5 },
    }),
    prop("description", "string", {
      query: { searchable: true, text: true },
    }),
    prop("status", stringEnum(["draft", "active", "paused", "completed"]), {
      query: { searchable: true, filterable: true, exact: true, facet: true },
    }),
    prop("phase", "string", {
      nullable: true,
      query: { searchable: true, filterable: true, exact: true },
    }),
    prop("deadline", "date", {
      query: { searchable: true, filterable: true, sortable: true },
    }),
    prop("budget", "double", {
      query: { searchable: true, filterable: true, sortable: true },
    }),
  ],
  search: {
    title: "name",
    defaultText: ["name", "description"],
    exact: ["id", "name"],
  },
  links: [
    link("customer", Customer, { cardinality: "one" }),
    link("lead", Employee, { cardinality: "one" }),
  ],
})
```

| Metadata | Enables |
| --- | --- |
| `searchable` | Required gate for the other query flags on a property. |
| `filterable` | `where(...)` predicates such as `eq`, `neq`, ranges, `in`, `exists`, and `contains`. |
| `sortable` | `orderBy(...)` on the property. |
| `text` | `.search(...)` over the property. The field must be static and string-like. |
| `exact` | Exact-match search profiles such as `search.exact`; primary ids are exact-matchable by default. |
| `facet` | Enables `.facets(...)` bucket counts on exact-matchable fields. |
| `vector` | Vector search on numeric-array embedding fields when the storage provider supports it. |
| `weight` | Relative text-search weight for providers that support ranking. |

Predicate values are still checked against the property schema. For example, range predicates
and sorting work on orderable schemas such as strings, numbers, dates, timestamps, uuids, and
enums.


## Basic Queries

`sixb.objects(Project).query()` starts with every `Project` object and returns a builder.
Each chained method narrows or reshapes the current object set.

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

Use `first()` when you only need one object:

```ts
const project = await sixb
  .objects(Project)
  .query()
  .where((project) => project.p.id.eq("proj-001"))
  .first()
```

`list()` returns full object rows:

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

Totals are included by default for backward compatibility. Infinite-scroll UIs can skip the count
query and keep only page state:

```ts
const page = await sixb
  .objects(Project)
  .query()
  .orderBy(Project.p.deadline, "asc")
  .page({ pageSize: 50, pageToken })
  .list({ includeTotal: false })

console.log(page.objects, page.hasMore, page.nextPageToken)
```

Use `count()` when you only need the matching-set size:

```ts
const activeProjectCount = await sixb
  .objects(Project)
  .query()
  .where((project) => project.p.status.eq("active"))
  .count()
```

`count()` runs a count-only storage query for providers that support object-query pushdown.
It does not fetch or hydrate object rows.

Use `exists()` for cheap yes/no checks:

```ts
const hasLiveProjects = await sixb
  .objects(Project)
  .query()
  .where((project) => project.p.status.eq("active"))
  .exists()
```

`exists()` runs an existence probe that stops after the first matching object.

Use `facets()` when you need counts grouped by category:

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
nodes such as `limit`, `page`, `sort`, and `project` do not restrict facet counts.


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

Combine predicates with `and`, `or`, and `not`:

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

Ordered comparisons such as `lt`, `lte`, `gt`, and `gte` do not match null or missing
values. Sorting places null or missing sort values after present values in both ascending
and descending order.

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

You can search specific text-enabled fields with property tokens:

```ts
const projects = await sixb
  .objects(Project)
  .query()
  .search("energy dashboard", { fields: [Project.p.name, Project.p.description] })
  .limit(10)
  .list()
```

Search terms are whitespace-tokenized. Portable text search treats all terms as required
matches across the selected fields. Providers with ranking support may also use field
weights and relevance ordering:

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


## Sorting And Limits

Use `orderBy(propertyToken, direction)` for deterministic ordering:

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
executes through `.list()`, `.count()`, `.exists()`, `.facets()`, `.first()`, or the HTTP route.


## Raw Query JSON

Most app code should use the fluent API. Raw query JSON is useful when calling
`POST /api/objects/query`, using generated clients, or constructing queries outside
TypeScript.

Raw query nodes are nested with an `input` field. This query starts with `Project`, filters,
sorts, limits, and projects returned properties:

```json
{
  "query": {
    "kind": "project",
    "properties": ["id", "name", "status", "budget"],
    "input": {
      "kind": "limit",
      "limit": 20,
      "input": {
        "kind": "sort",
        "fields": [{ "kind": "property", "propertyId": "budget", "direction": "desc" }],
        "input": {
          "kind": "filter",
          "predicate": {
            "op": "and",
            "items": [
              { "op": "eq", "propertyId": "status", "value": "active" },
              { "op": "gte", "propertyId": "budget", "value": 50000 }
            ]
          },
          "input": { "kind": "start", "objectTypeId": "Project" }
        }
      }
    }
  }
}
```

The response includes matching objects and pagination metadata. The HTTP route also returns
a diagnostic `plan` object for debugging, but application code normally uses the object
fields below.

```json
{
  "objects": [],
  "hasMore": false,
  "total": 0
}
```

Call `POST /api/objects/query/count` with the same `query` body when you only need the
matching count. It returns `{ "count": number }` plus the same diagnostic `plan` shape as
the row-query route.

Call `POST /api/objects/query/exists` for yes/no checks. It returns
`{ "exists": boolean }` plus the same diagnostic `plan` shape.

Call `POST /api/objects/query/facets` for grouped counts:

```json
{
  "query": {
    "kind": "start",
    "objectTypeId": "Project"
  },
  "facets": [
    { "propertyId": "status", "limit": 10 }
  ]
}
```

The response returns one facet result per requested property plus the same diagnostic `plan` shape:

```json
{
  "facets": [
    {
      "propertyId": "status",
      "buckets": [
        { "value": "active", "count": 12 },
        { "value": "paused", "count": 3 }
      ]
    }
  ]
}
```

Raw `page` queries return an opaque `nextPageToken` when another page is available:

```json
{
  "query": {
    "kind": "page",
    "pageSize": 25,
    "input": {
      "kind": "sort",
      "fields": [{ "kind": "property", "propertyId": "deadline", "direction": "asc" }],
      "input": { "kind": "start", "objectTypeId": "Project" }
    }
  }
}
```

Send that token back as `pageToken` to read the next page:

```json
{
  "query": {
    "kind": "page",
    "pageSize": 25,
    "pageToken": "<nextPageToken>",
    "input": {
      "kind": "sort",
      "fields": [{ "kind": "property", "propertyId": "deadline", "direction": "asc" }],
      "input": { "kind": "start", "objectTypeId": "Project" }
    }
  }
}
```


## Raw Node Reference

| Node | Purpose |
| --- | --- |
| `start` | Begin with all objects of one type. Raw JSON can set `includeSubtypes: true`. |
| `filter` | Apply property predicates. |
| `text` | Keyword search over `search.defaultText` or explicit `fields`. |
| `vector` | Nearest-neighbor search on a numeric-array property when supported. |
| `traverse` | Follow an outgoing or incoming ontology link. |
| `set` | Combine compatible object sets with `union`, `intersect`, or `subtract`. |
| `sort` | Order by properties or provider-supported relevance. |
| `limit` | Bound the result count. |
| `page` | Request a cursor page. |
| `project` | Return only selected properties in raw query responses. |

| Predicate | Raw shape |
| --- | --- |
| `and` / `or` | `{ "op": "and", "items": [...] }` |
| `not` | `{ "op": "not", "item": ... }` |
| `eq` / `neq` / `lt` / `lte` / `gt` / `gte` | `{ "op": "eq", "propertyId": "status", "value": "active" }` |
| `in` | `{ "op": "in", "propertyId": "status", "values": ["active", "paused"] }` |
| `exists` | `{ "op": "exists", "propertyId": "deadline", "value": true }` |
| `contains` | `{ "op": "contains", "propertyId": "name", "value": "Acme" }` |


## Practical Support Notes

SQLite and PostgreSQL object storage support the common graph-query workflow: typed
property filters, text search, property sorting, limits, raw cursor pages, link traversal,
set operations, and raw projection.

Vector search and relevance sorting require storage-provider support. If a provider cannot
execute a requested feature, Sixb returns a structured planning error instead of silently
returning a partial or approximate result.

For simple bounded filters and sorts, Sixb can sometimes evaluate the query in the core
runtime when a storage provider lacks native query support. Treat text search, traversal,
set operations, vector search, and relevance sorting as provider-backed features.
