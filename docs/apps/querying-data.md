# Querying Data in Apps

The recommended way to read objects in an app is the **typed query builder**. Import your
ontology object types, build a query with `objects(Type).query()`, and feed it to a React
hook from `@sixb/client/hooks`. Property names and predicate values are checked at compile
time, and result rows are fully typed.

For the full query language (predicates, search, traversal, facets, paging), see
[Querying Objects](../objects/querying.md). For the client transport and provider setup, see
[Client](../client/overview.md) and [Typed Queries](../client/typed-queries.md).

## Typed Queries With Hooks

Build a query with `objects(Type).query()` from `@sixb/client/query`, then pass it to a
hook. The query is a plain value, so you can declare it at module scope and refine it at the
call site.

```tsx
import { useObjectsFacets, useObjectsQuery } from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import type { TwinObject } from "@sixb/core/query"
import { useState } from "react"
import { Project } from "../../ontology/project"

type ProjectRow = TwinObject<typeof Project, readonly []>
type ProjectStatus = "draft" | "active" | "paused" | "completed" | "cancelled"

const allProjects = objects(Project).query().orderBy(Project.p.deadline, "asc")

export default function ProjectsPage() {
  const [statusFilter, setStatusFilter] = useState<ProjectStatus | null>(null)

  const projectsQuery = useObjectsQuery(
    statusFilter
      ? allProjects.where((project) => project.p.status.eq(statusFilter))
      : allProjects.where((project) => project.p.status.in(["active", "paused"]))
  )

  const statusFacets = useObjectsFacets(objects(Project).query(), [
    { property: Project.p.status, limit: 10 },
  ])

  const projects = projectsQuery.data?.objects ?? []
  const buckets = statusFacets.data?.[0]?.buckets ?? []

  if (projectsQuery.isLoading) return <p>Loading projects...</p>
  if (projectsQuery.isError) return <p>Projects failed to load.</p>

  return (
    <main>
      <ul>
        {buckets.map((bucket) => {
          const status = String(bucket.value) as ProjectStatus
          return (
            <li key={status}>
              <button type="button" onClick={() => setStatusFilter(status)}>
                {status}: {bucket.count}
              </button>
            </li>
          )
        })}
      </ul>
      {projects.map((project: ProjectRow) => (
        <article key={project.primaryId}>
          <h2>{project.properties.name}</h2>
          <p>{project.properties.status}</p>
        </article>
      ))}
    </main>
  )
}
```

Rows are `TwinObject` values: each has `primaryId`, `objectTypeId`, `properties`,
`createdAt`, and `updatedAt`. The `properties` shape is inferred from the object type, so
`project.properties.name` and `project.properties.status` are typed — no string keys, no
casts.

Hooks key the cache on the normalized query IR, so identical queries share cache entries and
inline builders are safe to construct on every render.

## App Hooks

All hooks accept a built query (anything carrying a normalized `.ir`) and an optional second
argument for common TanStack options such as `enabled`, `staleTime`, and `refetchInterval`.

| Hook | Returns | Use for |
| --- | --- | --- |
| `useObjectsQuery(query, opts?)` | `{ objects, total, hasMore, nextPageToken }` | Listing matching rows. |
| `useObjectsCount(query, opts?)` | `number` | Matching-set size without fetching rows. |
| `useObjectsExists(query, opts?)` | `boolean` | Cheap yes/no checks. |
| `useObjectsFacets(query, facets, opts?)` | `ObjectQueryFacetResult[]` | Bucket counts grouped by a property. |
| `useObjectsInfinite(query, { pageSize })` | TanStack infinite pages | Cursor-paged infinite scroll. |

`useObjectsFacets` takes facet requests as `{ property: Project.p.status, limit: 10 }`. The
property must declare `query.searchable: true` and `query.facet: true` in the ontology.

`useObjectsInfinite` pages through results with `nextPageToken` and skips the count query:

```tsx
import { useObjectsInfinite } from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import { Project } from "../../ontology/project"

const { data, fetchNextPage, hasNextPage } = useObjectsInfinite(
  objects(Project).query().search("dashboard"),
  { pageSize: 50 }
)
```

Shared queries live in a module and are refined per call site:

```tsx
// queries/projects.ts
export const openProjects = objects(Project)
  .query()
  .where((project) => project.p.status.in(["active", "paused"]))
  .orderBy(Project.p.deadline, "asc")

// component
const { data } = useObjectsQuery(openProjects.limit(50))
const { data: openCount } = useObjectsCount(openProjects)
```

For router loaders, prefetching, or full TanStack control, use the
`objectQueryOptions`, `objectQueryCountOptions`, `objectQueryExistsOptions`,
`objectQueryFacetsOptions`, and `objectQueryInfiniteOptions` factories with `useQuery` or
`queryClient.prefetchQuery`.

## Importing Ontology Types

Ontology files that browser code imports must define their types via the browser-safe
entrypoint `@sixb/core/ontology`, not the `@sixb/core` root — the root pulls server runtime
modules into the bundle.

```ts
// ontology/project.ts
import { defineObjectType, link, prop, stringEnum } from "@sixb/core/ontology"
```

`TwinObject` and other query types come from `@sixb/core/query`, which is also browser-safe.

## Typed vs Untyped

Two read paths are available. Prefer the **typed** builder for app screens.

| | Untyped: `listObjectsOptions` | Typed: `objects(Type).query()` |
| --- | --- | --- |
| Import | `@sixb/client/hooks` | `@sixb/client/query` + `@sixb/client/hooks` |
| Target type | `objectTypeId` string | Imported object type |
| Result rows | `ObjectSummary[]` | Typed `TwinObject` rows |
| Property access | Stringly-typed | Inferred from the object type |
| Predicates | None (id prefix, timestamps, offset only) | Full `where(...)` predicates |
| Search / facets / traversal | No | Yes |
| Paging | Offset-based | Cursor-based (`useObjectsInfinite`) |
| Best for | Quick generic browsing | Real app screens |

The untyped path is the documented escape hatch — useful when you only know an
`objectTypeId` string and want a generic list, with no compile-time property typing:

```tsx
import { listObjectsOptions } from "@sixb/client/hooks"
import { useQuery } from "@tanstack/react-query"

const query = useQuery(
  listObjectsOptions({
    query: { objectTypeId: "Project", limit: "50" },
  })
)

// rows are ObjectSummary[]; properties are not typed
query.data?.map((object) => object.primaryId)
```

For everything else — filtering, search, facets, link traversal, paging, and typed rows —
use the typed builder.

## Related

- [Querying Objects](../objects/querying.md) — the full query language and predicate reference.
- [Client](../client/overview.md) — the browser client and transport.
- [Typed Queries](../client/typed-queries.md) — typed queries from the browser in depth.
- [Apps](overview.md) — building app screens and routes.
