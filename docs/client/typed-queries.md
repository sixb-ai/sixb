# Typed Object Queries & Hooks

`@sixb/client/query` gives browser code the same fluent object-query builder the server
runtime uses, wired to the HTTP API. Reach for it when you query objects from a custom app
or React frontend and want compile-time-checked property names and predicate values.

`objects(Type)` builds the identical query IR as the runtime and runs it through the
generated SDK, so auth and CSRF come from your existing client config. React apps add
TanStack Query hooks (`@sixb/client/hooks`) keyed on the normalized query IR.

For the full builder reference — filters, traversal, search, ordering — see
[/objects/querying](../objects/querying.md). For SDK setup, see [/client](overview.md).

## Builder over HTTP

`objects(Type).query()` returns the builder. Import your ontology types directly; there is
no registration step. Property names and predicate values are type-checked at compile time,
and the server validates every query against the registered ontology.

```ts
import { objects } from "@sixb/client/query"
import { Project } from "../ontology/project"

const { objects: rows } = await objects(Project)
  .query()
  .where((project) => project.p.status.eq("active"))
  .orderBy(Project.p.deadline, "asc")
  .limit(20)
  .list()
```

Terminals run through the object-query routes via the generated SDK:

| Terminal       | Route                      | Returns                                        |
| -------------- | -------------------------- | ---------------------------------------------- |
| `.list()`      | `POST /api/objects/query`        | `{ objects, hasMore, total?, nextPageToken? }` |
| `.first()`     | `POST /api/objects/query`        | first row or `null`                            |
| `.count()`     | `POST /api/objects/query/count`  | `number`                                       |
| `.exists()`    | `POST /api/objects/query/exists` | `boolean`                                      |
| `.facets([…])` | `POST /api/objects/query/facets` | `ObjectQueryFacetResult[]`                     |

Each row carries `primaryId`, `objectTypeId`, `properties`, and `Date`-typed `createdAt`
and `updatedAt`. `Date` predicate values survive the JSON wire format.

> `validate()` and `explain()` need ontology access and are server-side only — they are not
> on the client builder.

### Browser-safe ontology imports

Ontology files that browser code imports must define types via `@sixb/core/ontology` — the
same `defineObjectType`, `prop`, `link`, and friends as the `@sixb/core` root, but without
pulling the server runtime into the bundle.

```ts
import { defineObjectType, prop } from "@sixb/core/ontology"
```

## React hooks

Hooks come from `@sixb/client/hooks` and take a built query directly — any query from the
docs, the server runtime, or an event handler works unchanged. They key the cache on the
normalized query IR, so identical queries share cache entries and inline builders are safe
to construct on every render.

| Hook                 | Query terminal | Result type                |
| -------------------- | -------------- | -------------------------- |
| `useObjectsQuery`    | `list()`       | `ListResult<Row>`          |
| `useObjectsInfinite` | paged `list()` | `InfiniteData<…>`          |
| `useObjectsCount`    | `count()`      | `number`                   |
| `useObjectsExists`   | `exists()`     | `boolean`                  |
| `useObjectsFacets`   | `facets()`     | `ObjectQueryFacetResult[]` |

```tsx
import { useObjectsFacets, useObjectsQuery } from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import { Project } from "../ontology/project"

function ProjectList() {
  const projects = useObjectsQuery(
    objects(Project)
      .query()
      .where((project) => project.p.status.eq("active"))
      .orderBy(Project.p.deadline, "asc")
      .limit(20)
  )

  // Group counts by status, for filter pills.
  const statusFacets = useObjectsFacets(objects(Project).query(), [
    { property: Project.p.status, limit: 10 },
  ])
  const buckets = statusFacets.data?.[0]?.buckets ?? []

  if (projects.isLoading) return <p>Loading…</p>
  if (projects.isError) return <p>Failed to load.</p>
  return <ul>{projects.data?.objects.map((p) => <li key={p.primaryId}>{p.properties.name}</li>)}</ul>
}
```

`useObjectsFacets` takes the query plus an array of `{ property, limit }` requests; only
properties with `query.facet` are facetable (`Invoice.status`, `Project.status`).

`useObjectsInfinite` threads `nextPageToken` automatically and requests pages with
`includeTotal: false`:

```tsx
import { useObjectsInfinite } from "@sixb/client/hooks"

const pages = useObjectsInfinite(objects(Project).query().search("dashboard"), {
  pageSize: 50,
})
```

### Hook options

`useObjectsQuery`, `useObjectsCount`, `useObjectsExists`, and `useObjectsFacets` accept a
final options argument with common TanStack passthroughs:

| Option                 | Type                | Notes                   |
| ---------------------- | ------------------- | ----------------------- |
| `enabled`              | `boolean`           | gate the query          |
| `staleTime`            | `number`            | ms before data is stale |
| `gcTime`               | `number`            | ms before cache eviction |
| `refetchInterval`      | `number \| false`   | polling interval        |
| `refetchOnWindowFocus` | `boolean`           |                         |
| `retry`                | `boolean \| number` |                         |

`useObjectsInfinite` takes `{ pageSize }` plus `enabled`, `staleTime`, `gcTime`, and
`refetchInterval`. For anything beyond these passthroughs (`select`, `placeholderData`, …),
compose the option factories below with `useQuery` directly.

## Shared queries

Queries are plain values, so define them once in a module and refine them at the call site.
Each refinement (`.where(…)`, `.limit(…)`) returns a new query value, and the cache key
follows the resulting IR.

```tsx
// queries/projects.ts
import { objects } from "@sixb/client/query"
import { Project } from "../ontology/project"

export const openProjects = objects(Project)
  .query()
  .where((project) => project.p.status.in(["active", "paused"]))
  .orderBy(Project.p.deadline, "asc")

// component
const { data } = useObjectsQuery(openProjects.limit(50))
const { data: openCount } = useObjectsCount(openProjects)
```

## Option factories

For router loaders, prefetching, SSR, or full TanStack control, use the option factories
instead of the hooks. Each returns a TanStack `queryOptions`/`infiniteQueryOptions` object
keyed on the normalized IR, so it shares cache entries with the matching hook.

| Factory                      | Pairs with           | Arguments               |
| ---------------------------- | -------------------- | ----------------------- |
| `objectQueryOptions`         | `useObjectsQuery`    | `(query, options?)`     |
| `objectQueryCountOptions`    | `useObjectsCount`    | `(query)`               |
| `objectQueryExistsOptions`   | `useObjectsExists`   | `(query)`               |
| `objectQueryFacetsOptions`   | `useObjectsFacets`   | `(query, facets)`       |
| `objectQueryInfiniteOptions` | `useObjectsInfinite` | `(query, { pageSize })` |

```tsx
import { objectQueryOptions } from "@sixb/client/hooks"
import { useQuery } from "@tanstack/react-query"
import { openProjects } from "../queries/projects"

// Prefetch in a loader
await queryClient.prefetchQuery(objectQueryOptions(openProjects.limit(50)))

// Full TanStack control in a component
const { data } = useQuery({
  ...objectQueryOptions(openProjects.limit(50)),
  placeholderData: (prev) => prev,
})
```

## Query Keys and Invalidation

The hooks export stable object-query keys and exact invalidation helpers for apps that need
manual cache control:

```tsx
import { invalidateObjectQuery, objectQueryKeys } from "@sixb/client/hooks"

await queryClient.invalidateQueries({
  queryKey: objectQueryKeys.count(openProjects),
  exact: true,
})

await invalidateObjectQuery(queryClient, openProjects.limit(50))
```

For action buttons, prefer `useActionRunMutation({ invalidateOnCommit: true })`. It waits for
the terminal action run and invalidates action-run caches plus object-query caches when the run
commits edits.

## Transport overrides

Hooks execute the query IR through the global SDK client (`client`, exported from
`@sixb/client`). Wrap a subtree in `SixbProvider` to override the transport — base URL,
auth, fetch — for every hook beneath it. `SixbProvider` takes a hey-api `Client` instance:

```tsx
import { client } from "@sixb/client"
import { SixbProvider } from "@sixb/client/hooks"

function App() {
  return (
    <SixbProvider client={client}>
      <ProjectList />
    </SixbProvider>
  )
}
```

A per-query client passed to `objects(Type, { client })` applies to imperative calls like
`.list()` and `.count()`, **not** to hooks — hooks always bind to the nearest `SixbProvider`
client (or the global client).

```ts
const rows = await objects(Project, { client }).query().list()
```

## Errors

Validation and planning failures throw `SixbQueryError`, carrying the structured `issues`
array from the route (unknown properties, wrong value types, unsupported traversal shapes,
provider capability limits, …). Inside hooks the error surfaces on `query.error` /
`query.isError`.

```ts
import { objects, SixbQueryError } from "@sixb/client/query"

try {
  await objects(Project).query().where((p) => p.p.unknown.eq("x")).list()
} catch (error) {
  if (error instanceof SixbQueryError) {
    console.error(error.message, error.issues)
  }
}
```

| Member    | Type                          | Description                       |
| --------- | ----------------------------- | --------------------------------- |
| `message` | `string`                      | `[SixbClient] …` prefixed message |
| `issues`  | `readonly ObjectQueryIssue[]` | structured validation issues      |

## Related

- [/objects/querying](../objects/querying.md) — fluent builder reference
- [/objects/http-reference](../objects/http-reference.md) — query route contracts
- [/apps/querying-data](../apps/querying-data.md) — querying from custom apps
- [/client/events](events.md) — live event hooks and invalidation patterns
- [/apps/actions](../apps/actions.md) — running actions and invalidating queries from apps
- [/client](overview.md) — SDK setup and client configuration
