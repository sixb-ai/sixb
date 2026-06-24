# Typed Object Queries & Hooks

`@sixb/client/query` exposes the same fluent object-query builder the server runtime
uses, wired to the HTTP API. `objects(Type)` builds the identical query IR as the runtime
and executes it through the generated SDK, so authentication and CSRF handling come from
your existing client configuration. React apps layer TanStack Query hooks
(`@sixb/client/hooks`) on top, keyed on the normalized query IR.

See [/objects/querying](../objects/querying.md) for the full builder reference (filters,
traversal, search, ordering), and [/client](overview.md) for SDK setup.

## Builder over HTTP

`objects(Type).query()` returns the fluent builder. Import your ontology types directly —
no registration step. Property names and predicate values are type-checked at compile
time; the server validates every query against the registered ontology.

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

The builder runs through the object query routes via the generated SDK:

| Terminal      | Route                        | Returns                                  |
| ------------- | ---------------------------- | ---------------------------------------- |
| `.list()`     | `POST /api/objects/query`    | `{ objects, hasMore, total?, nextPageToken? }` |
| `.first()`    | `POST /api/objects/query`    | first row or `null`                      |
| `.count()`    | `POST /api/objects/count`    | `number`                                 |
| `.exists()`   | `POST /api/objects/exists`   | `boolean`                                |
| `.facets([…])`| `POST /api/objects/facets`   | `ObjectQueryFacetResult[]`               |

Row objects carry `primaryId`, `objectTypeId`, `properties`, and `Date`-typed `createdAt`
and `updatedAt`. `Date` predicate values survive the JSON wire format.

> `validate()` and `explain()` require ontology access and are server-side only — they are
> not available on the client builder.

### Browser-safe ontology imports

Ontology files that browser code imports should define types via the browser-safe
entrypoint `@sixb/core/ontology` (same `defineObjectType`, `prop`, `link`, and friends)
rather than the `@sixb/core` root, which pulls server runtime modules into the bundle.

```ts
import { defineObjectType, prop } from "@sixb/core/ontology"
```

## React hooks

Hooks come from `@sixb/client/hooks`. Each takes a
built query directly — any query from the docs, the server runtime, or an event handler
works unchanged. Hooks key the cache on the normalized query IR, so identical queries
share cache entries and inline builders are safe to construct on every render.

| Hook                  | Query terminal | Result type                      |
| --------------------- | -------------- | -------------------------------- |
| `useObjectsQuery`     | `list()`       | `ListResult<Row>`                |
| `useObjectsInfinite`  | paged `list()` | `InfiniteData<…>`                |
| `useObjectsCount`     | `count()`      | `number`                         |
| `useObjectsExists`    | `exists()`     | `boolean`                        |
| `useObjectsFacets`    | `facets()`     | `ObjectQueryFacetResult[]`       |

```tsx
import { useObjectsInfinite, useObjectsQuery } from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import { Project } from "../ontology/project"

const { data, isLoading } = useObjectsQuery(
  objects(Project)
    .query()
    .where((project) => project.p.status.eq("active"))
    .orderBy(Project.p.deadline, "asc")
    .limit(20)
)

const pages = useObjectsInfinite(objects(Project).query().search("dashboard"), {
  pageSize: 50,
})
```

`useObjectsInfinite` threads `nextPageToken` automatically; its query function requests
pages with `includeTotal: false`. `useObjectsFacets` takes the query plus an array of
`{ property, limit }` facet requests:

```tsx
import { useObjectsFacets } from "@sixb/client/hooks"

const statusFacets = useObjectsFacets(objects(Project).query(), [
  { property: Project.p.status, limit: 10 },
])
const buckets = statusFacets.data?.[0]?.buckets ?? []
```

### Hook options

`useObjectsQuery`, `useObjectsCount`, `useObjectsExists`, and `useObjectsFacets` accept a
final options argument with common TanStack passthroughs:

| Option                 | Type                | Notes                          |
| ---------------------- | ------------------- | ------------------------------ |
| `enabled`              | `boolean`           | gate the query                 |
| `staleTime`            | `number`            | ms before data is stale        |
| `gcTime`               | `number`            | ms before cache eviction       |
| `refetchInterval`      | `number \| false`   | polling interval               |
| `refetchOnWindowFocus` | `boolean`           |                                |
| `retry`                | `boolean \| number` |                                |

`useObjectsInfinite` takes `{ pageSize }` plus `enabled`, `staleTime`, `gcTime`, and
`refetchInterval`. For anything beyond these passthroughs (`select`, `placeholderData`, …),
compose the option factories below with `useQuery` directly.

## Shared queries

Because queries are plain values, shared queries can live in a module and be refined at the
call site. Refinements (`.where(…)`, `.limit(…)`) produce a new query value, and the cache
key follows the resulting IR.

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

| Factory                       | Pairs with           | Arguments                          |
| ----------------------------- | -------------------- | ---------------------------------- |
| `objectQueryOptions`          | `useObjectsQuery`    | `(query, options?)`                |
| `objectQueryCountOptions`     | `useObjectsCount`    | `(query)`                          |
| `objectQueryExistsOptions`    | `useObjectsExists`   | `(query)`                          |
| `objectQueryFacetsOptions`    | `useObjectsFacets`   | `(query, facets)`                  |
| `objectQueryInfiniteOptions`  | `useObjectsInfinite` | `(query, { pageSize })`            |

The factories accept any query-shaped value, so the same builder works in loaders,
prefetch calls, and components alike.

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

## Transport overrides

Hooks execute the query IR through the global SDK client (`client`, exported from
`@sixb/client`). Wrap a subtree in `SixbProvider` to override the transport (base URL,
auth, fetch) for every hook beneath it. `SixbProvider` takes a hey-api `Client` instance:

```tsx
import { client } from "@sixb/client"
import { SixbProvider } from "@sixb/client/hooks"

function App() {
  return (
    <SixbProvider client={client}>
      <Projects />
    </SixbProvider>
  )
}
```

A per-query client passed to `objects(Type, { client })` applies to imperative calls such
as `.list()` and `.count()`, **not** to hooks — hooks always bind to the nearest
`SixbProvider` client (or the global client).

```ts
const rows = await objects(Project, { client }).query().list()
```

## Errors

Validation and planning failures throw `SixbQueryError`, carrying the structured `issues`
array returned by the route (unknown properties, wrong value types, unsupported traversal
shapes, provider capability limits, …). Inside hooks the error surfaces on
`query.error` / `query.isError`.

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

| Member    | Type                          | Description                          |
| --------- | ----------------------------- | ------------------------------------ |
| `message` | `string`                      | `[SixbClient] …` prefixed message    |
| `issues`  | `readonly ObjectQueryIssue[]` | structured validation issues         |

## Related

- [/objects/querying](../objects/querying.md) — fluent builder reference
- [/objects/http-reference](../objects/http-reference.md) — query route contracts
- [/apps/querying-data](../apps/querying-data.md) — querying from custom apps
- [/client](overview.md) — SDK setup and client configuration
