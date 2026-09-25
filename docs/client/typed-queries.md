# Queries & hooks

Use `objects(Type).query()` from `@sixb/client/query` to query a Sixb API with types from your ontology. React hooks add caching and loading state to the same queries.

See [Object queries](../objects/querying.md) for filters, search, sorting, and relationships, or [Querying data in apps](../apps/querying-data.md) for a complete page example.

## Query objects

```ts
import { objects } from "@sixb/client/query"
import { Invoice } from "../ontology/invoice"

const result = await objects(Invoice)
  .query()
  .where((invoice) => invoice.p.status.eq("open"))
  .limit(20)
  .list()
```

| Method | Returns |
| --- | --- |
| `.list()` | Objects, `hasMore`, and optional `total` and `nextPageToken`. |
| `.first()` | The first matching object or `null`. |
| `.count()` | A count. |
| `.exists()` | Whether a match exists. |
| `.facets(requests)` | Counts grouped by facetable properties. |

Rows include `primaryId`, `objectTypeId`, typed `properties`, and `Date` timestamps. Use [relationship expansion](../objects/querying.md#include-related-objects) to include linked objects.

### Browser-safe ontology imports

Define ontology types imported by frontend code through `@sixb/core/ontology`. This avoids bundling the server runtime.

```ts
import { defineObjectType, prop } from "@sixb/core/ontology"
```

Queries are typed exactly as they are on the server. For precise linked-object types, run `bun sixb typegen` before a standalone TypeScript check. `dev`, `build`, and `check` generate these types automatically.

## React hooks

Hooks accept a query and share cached results when the query is identical.

| Hook | Use for |
| --- | --- |
| `useObjectsQuery(query, options?)` | A page of results. |
| `useObjectsInfinite(query, options)` | Paginated results with a `pageSize`. |
| `useObjectsCount(query, options?)` | A count. |
| `useObjectsExists(query, options?)` | A boolean. |
| `useObjectsFacets(query, facets, options?)` | Grouped counts. |

```tsx
import { useObjectsQuery } from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import { Invoice } from "../ontology/invoice"

function InvoiceCount() {
  const query = useObjectsQuery(objects(Invoice).query().limit(20))

  if (query.isLoading) return <p>Loading...</p>
  if (query.isError) return <p>Could not load invoices.</p>
  return <p>{query.data?.objects.length ?? 0} invoices loaded</p>
}
```

Common options include `enabled`, `staleTime`, `gcTime`, and `refetchInterval`. The non-infinite hooks also accept `retry` and `refetchOnWindowFocus`.

## Reuse queries

Define shared queries in a module. Refining a query returns a new value without changing the original:

```ts
// queries/invoices.ts
import { objects } from "@sixb/client/query"
import { Invoice } from "../ontology/invoice"

export const openInvoices = objects(Invoice)
  .query()
  .where((invoice) => invoice.p.status.eq("open"))
```

Pass `openInvoices.limit(50)` to a hook or call its `.list()` method directly.

## Option factories

Use option factories for prefetching, loaders, or additional TanStack Query options.

| Factory | Arguments |
| --- | --- |
| `objectQueryOptions` | Query and optional list options. |
| `objectQueryCountOptions` | Query. |
| `objectQueryExistsOptions` | Query. |
| `objectQueryFacetsOptions` | Query and facet requests. |
| `objectQueryInfiniteOptions` | Query and options including `pageSize`. |

For example, prefetch into your existing QueryClient:

```ts
import { objectQueryOptions } from "@sixb/client/hooks"
import { openInvoices } from "../queries/invoices"

await queryClient.prefetchQuery(objectQueryOptions(openInvoices.limit(50)))
```

## Refresh cached data

For action buttons, use [`useActionRunMutation`](../apps/actions.md#refresh-data) with `invalidateOnCommit: true`. For manual invalidation, use the exported query keys or helper:

```ts
import { invalidateObjectQuery, objectQueryKeys } from "@sixb/client/hooks"
import { openInvoices } from "../queries/invoices"

await queryClient.invalidateQueries({ queryKey: objectQueryKeys.count(openInvoices) })
await invalidateObjectQuery(queryClient, openInvoices.limit(50))
```

## Client overrides

Hooks use the client from the nearest `SixbProvider`, or the shared client when no provider is present. Pass a configured client to `SixbProvider` when a React subtree needs a different API connection.

For imperative queries, pass the client to `objects`:

```ts
const result = await objects(Invoice, { client }).query().list()
```

That per-query override does not override a hook's provider.

## Query errors

Invalid queries reject with `SixbQueryError`, exported from `@sixb/client/query`. Inspect its `issues` for validation details. In React, failures appear on the hook's `error` and `isError` properties.
