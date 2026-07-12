# Querying Data in Apps

The recommended way to read objects in an app is the **typed query builder**. Import your
ontology object types, build a query with `objects(Type).query()`, and feed it to a React hook
from `@sixb/client/hooks`. Property names and predicate values are checked at compile time, and
result rows are fully typed.

For the full query language (predicates, search, traversal, facets, paging) see
[Querying Objects](../objects/querying.md). For client transport and provider setup see
[Client](../client/overview.md) and [Typed Queries](../client/typed-queries.md).

## Typed Queries With Hooks

Build a query with `objects(Type).query()` from `@sixb/client/query`, then pass it to a hook. The
query is a plain value, so you can declare it at module scope and refine it at the call site.

```tsx
import { useObjectsFacets, useObjectsQuery } from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import type { TwinObject } from "@sixb/core/query"
import { useState } from "react"
import { Invoice } from "../../ontology/invoice"

type InvoiceRow = TwinObject<typeof Invoice, readonly []>
type InvoiceStatus = "draft" | "sent" | "paid" | "overdue" | "cancelled"

const allInvoices = objects(Invoice).query().orderBy(Invoice.p.dueDate, "asc")

export default function InvoicesPage() {
  const [statusFilter, setStatusFilter] = useState<InvoiceStatus | null>(null)

  const invoicesQuery = useObjectsQuery(
    statusFilter
      ? allInvoices.where((invoice) => invoice.p.status.eq(statusFilter))
      : allInvoices.where((invoice) => invoice.p.status.in(["sent", "overdue"]))
  )

  const statusFacets = useObjectsFacets(objects(Invoice).query(), [
    { property: Invoice.p.status, limit: 10 },
  ])

  const invoices = invoicesQuery.data?.objects ?? []
  const buckets = statusFacets.data?.[0]?.buckets ?? []

  if (invoicesQuery.isLoading) return <p>Loading invoices...</p>
  if (invoicesQuery.isError) return <p>Invoices failed to load.</p>

  return (
    <main>
      <ul>
        {buckets.map((bucket) => {
          const status = String(bucket.value) as InvoiceStatus
          return (
            <li key={status}>
              <button type="button" onClick={() => setStatusFilter(status)}>
                {status}: {bucket.count}
              </button>
            </li>
          )
        })}
      </ul>
      {invoices.map((invoice: InvoiceRow) => (
        <article key={invoice.primaryId}>
          <h2>{invoice.properties.number}</h2>
          <p>{invoice.properties.status}</p>
        </article>
      ))}
    </main>
  )
}
```

Rows are `TwinObject` values: each has `primaryId`, `objectTypeId`, `properties`, `createdAt`, and
`updatedAt`. The `properties` shape is inferred from the object type, so `invoice.properties.number`
and `invoice.properties.status` are typed — no string keys, no casts.

Hooks key the cache on the normalized query IR, so identical queries share cache entries and inline
builders are safe to construct on every render.

## App Hooks

Each hook accepts a built query (anything carrying a normalized `.ir`). The list/count/exists/facets
hooks take an optional second argument for common TanStack options such as `enabled`, `staleTime`,
`gcTime`, and `refetchInterval`. `useObjectsInfinite` instead takes a required second argument
carrying `pageSize` (those same TanStack options are also accepted there).

| Hook | Returns | Use for |
| --- | --- | --- |
| `useObjectsQuery(query, opts?)` | `{ objects, total, hasMore, nextPageToken }` | Listing matching rows. |
| `useObjectsCount(query, opts?)` | `number` | Matching-set size without fetching rows. |
| `useObjectsExists(query, opts?)` | `boolean` | Cheap yes/no checks. |
| `useObjectsFacets(query, facets, opts?)` | `ObjectQueryFacetResult[]` | Bucket counts grouped by a property. |
| `useObjectsInfinite(query, { pageSize })` | TanStack infinite pages | Cursor-paged infinite scroll. |

`useObjectsFacets` takes facet requests as `{ property: Invoice.p.status, limit: 10 }`. The property
must declare `query.facet: true` in the ontology (`Invoice.status` does; `Invoice.amount` does not).

`useObjectsInfinite` pages through results with `nextPageToken` and skips the count query:

```tsx
import { useObjectsInfinite } from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import { Invoice } from "../../ontology/invoice"

const { data, fetchNextPage, hasNextPage } = useObjectsInfinite(
  objects(Invoice).query().search("ACME-2026"),
  { pageSize: 50 }
)
```

Define shared queries in a module and refine them per call site:

```tsx
// queries/invoices.ts
export const openInvoices = objects(Invoice)
  .query()
  .where((invoice) => invoice.p.status.in(["sent", "overdue"]))
  .orderBy(Invoice.p.dueDate, "asc")

// component
const { data } = useObjectsQuery(openInvoices.limit(50))
const { data: openCount } = useObjectsCount(openInvoices)
```

For router loaders, prefetching, or full TanStack control, use the `objectQueryOptions`,
`objectQueryCountOptions`, `objectQueryExistsOptions`, `objectQueryFacetsOptions`, and
`objectQueryInfiniteOptions` factories with `useQuery` or `queryClient.prefetchQuery`.

## Importing Ontology Types

Ontology files that browser code imports must define their types via the browser-safe entrypoint
`@sixb/core/ontology`, not the `@sixb/core` root — the root pulls server runtime modules into the
bundle.

```ts
// ontology/invoice.ts
import { defineObjectType, link, prop, stringEnum } from "@sixb/core/ontology"
```

`TwinObject` and the other query types come from `@sixb/core/query`, which is also browser-safe.

## Typed vs Untyped

Two read paths are available. Prefer the **typed** builder for app screens.

| | Untyped: `listObjectsOptions` | Typed: `objects(Type).query()` |
| --- | --- | --- |
| Import | `@sixb/client/hooks` | `@sixb/client/query` + `@sixb/client/hooks` |
| Target type | `objectTypeId` string | Imported object type |
| Result rows | `ObjectSummary[]` | Typed `TwinObject` rows |
| Property access | Stringly-typed | Inferred from the object type |
| Predicates | None (id prefix, timestamps, offset only) | Full `where(...)` predicates |
| Search / facets / traversal / expansion | No | Yes |
| Paging | Offset-based | Cursor-based (`useObjectsInfinite`) |
| Best for | Quick generic browsing | Real app screens |

The untyped path is the documented escape hatch — useful when you only know an `objectTypeId`
string and want a generic list, with no compile-time property typing:

```tsx
import { listObjectsOptions } from "@sixb/client/hooks"
import { useQuery } from "@tanstack/react-query"

const query = useQuery(
  listObjectsOptions({
    query: { objectTypeId: "Invoice", limit: "50" },
  })
)

// rows are ObjectSummary[]; properties are not typed
query.data?.map((object) => object.primaryId)
```

For everything else — filtering, search, facets, link traversal and expansion, paging, and typed
rows — use the typed builder.

### Expanding related objects

When a screen needs an object together with its related objects — an invoice and its customer, a
project and its team — use `.expand(link)` to attach the linked objects to each row under `.links`,
instead of running a second query. Rows stay typed, so `.links.<link>` is `Target | null` (a
`"one"` link) or `Target[]` (a `"many"` link).

```tsx
const projects = useObjectsQuery(
  objects(Project)
    .query()
    .where((project) => project.p.status.eq("active"))
    .expand(Project.l.customer)
    .expand(Project.l.tasks, { limit: 5, orderBy: [{ property: Task.p.dueDate, direction: "asc" }] })
)

const customerName = projects.data?.objects[0]?.links.customer?.properties.name
```

See [expanding links](../objects/querying.md#expanding-links) for cardinality, nesting, and
per-parent limits, and note that precise expand types need the generated
[type manifest](../client/typed-queries.md#expanding-links) (`sixb typegen`, run automatically by
`sixb dev`).

## Invalidating After Actions

For app buttons that run actions, prefer `useActionRunMutation({ invalidateOnCommit: true })`.
It waits for terminal action success or failure and refreshes object-query caches from the
committed run, so most screens do not need custom event listeners.

If you are handling events manually, use the exported key helpers instead of copying cache keys:

```tsx
import { invalidateObjectQuery } from "@sixb/client/hooks"
import { useQueryClient } from "@tanstack/react-query"
import { openInvoices } from "../queries/invoices"

const queryClient = useQueryClient()

await invalidateObjectQuery(queryClient, openInvoices.limit(50))
```

See [running actions](actions.md) for complete button, loading, and error patterns.

## Related

- [Querying Objects](../objects/querying.md) — the full query language and predicate reference.
- [Client](../client/overview.md) — the browser client and transport.
- [Typed Queries](../client/typed-queries.md) — typed queries from the browser in depth.
- [Client Events](../client/events.md) — live updates, telemetry hooks, and event invalidation.
- [Running actions](actions.md) — action buttons and cache invalidation in apps.
- [Apps](overview.md) — building app screens and routes.
