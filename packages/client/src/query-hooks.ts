/**
 * TanStack Query integration for typed object queries.
 *
 * Layer 1: `objectQuery*Options` factories for prefetching, loaders, and SSR.
 * Layer 2: `useObjects*` hooks for components. Both key on the normalized
 * query IR, so identical queries share cache entries — inline builders are
 * safe to construct on every render.
 */
import type {
  ListResult,
  ListResultWithoutTotal,
  ObjectQuery,
  ObjectQueryExecutor,
  ObjectQueryFacetResult,
  ObjectQueryListOptions,
} from "@sixb/core/query"
import {
  infiniteQueryOptions,
  queryOptions,
  type UseQueryResult,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query"
import { createContext, createElement, type ReactNode, useContext, useMemo } from "react"
import type { Client } from "./generated/client"
import { createHttpQueryExecutor } from "./query"

const objectQueryBaseKey = ["sixb", "objects"] as const

function objectQueryKey(scope: string, ir: ObjectQuery, extra?: unknown) {
  return [...objectQueryBaseKey, scope, ir, extra ?? null] as const
}

// Options factories accept anything query-shaped, so they work with builders
// from `objects()` here and from the server runtime alike.

/**
 * TanStack options for `query.list()`.
 *
 * Note on `includeTotal: false`: the request skips the count query and the
 * response omits `total` at runtime, but `data` is still typed `ListResult`
 * (with `total: number`). TanStack's `DataTag`-branded query keys are
 * invariant in the data type, so narrowing this truthfully requires unsafe
 * casts that aren't worth the niche path — infinite pagination, the main
 * no-total consumer, has its own correctly typed factory.
 */
export function objectQueryOptions<TObject>(
  query: {
    readonly ir: ObjectQuery
    list(options?: ObjectQueryListOptions): Promise<ListResult<TObject>>
  },
  options?: ObjectQueryListOptions
) {
  return queryOptions({
    queryKey: objectQueryKey("query", query.ir, options),
    queryFn: () => query.list(options),
  })
}

export function objectQueryCountOptions(query: {
  readonly ir: ObjectQuery
  count(): Promise<number>
}) {
  return queryOptions({
    queryKey: objectQueryKey("count", query.ir),
    queryFn: () => query.count(),
  })
}

export function objectQueryExistsOptions(query: {
  readonly ir: ObjectQuery
  exists(): Promise<boolean>
}) {
  return queryOptions({
    queryKey: objectQueryKey("exists", query.ir),
    queryFn: () => query.exists(),
  })
}

export function objectQueryFacetsOptions<TFacetInput>(
  query: {
    readonly ir: ObjectQuery
    facets(input: readonly TFacetInput[]): Promise<ObjectQueryFacetResult[]>
  },
  facets: readonly TFacetInput[]
) {
  return queryOptions({
    queryKey: objectQueryKey(
      "facets",
      query.ir,
      facets.map((facet) => {
        const { property, limit } = facet as { property?: { id?: string }; limit?: number }
        return { propertyId: property?.id, limit }
      })
    ),
    queryFn: () => query.facets(facets),
  })
}

export function objectQueryInfiniteOptions<TObject>(
  query: {
    readonly ir: ObjectQuery
    page(input: { pageSize: number; pageToken?: string }): {
      list(options: { includeTotal: false }): Promise<ListResultWithoutTotal<TObject>>
    }
  },
  options: { pageSize: number }
) {
  return infiniteQueryOptions({
    queryKey: objectQueryKey("infinite", query.ir, options.pageSize),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      query.page({ pageSize: options.pageSize, pageToken: pageParam }).list({
        includeTotal: false,
      }),
    getNextPageParam: (lastPage) => lastPage.nextPageToken,
  })
}

// Optional transport override. Without a provider, hooks use the global
// hey-api client, matching the rest of @sixb/client.

const SixbClientContext = createContext<Client | undefined>(undefined)

export function SixbProvider(props: { client: Client; children?: ReactNode }) {
  return createElement(SixbClientContext.Provider, { value: props.client }, props.children)
}

// Hooks accept any built query — anything carrying a normalized `.ir` — and
// execute that IR through the SixbProvider client (or the global client), so
// the same query value works in components, event handlers, loaders, and on
// the server. Hooks constrain the query to `{ ir }` only and extract result
// types with conditional `infer`: putting the builder in a callback parameter
// position, constraining on its overloaded members, or extracting via
// `ReturnType` all overflow TypeScript's recursion depth on real ontologies.

/**
 * Result row type of a built query, taken from its `first()` terminal.
 * Rebuilt as an anonymous structural type: relating the generic `TwinObject`
 * reference itself in deep contexts (e.g. `rows.map(...)` callbacks) can
 * overflow TypeScript's recursion limits.
 */
type BuiltRow<TBuilt> = TBuilt extends { first(): Promise<infer TRow> }
  ? NonNullable<TRow> extends { objectTypeId: infer TObjectTypeId; properties: infer TProperties }
    ? {
        primaryId: string
        objectTypeId: TObjectTypeId
        properties: TProperties
        createdAt: Date
        updatedAt: Date
      }
    : never
  : never

/**
 * Common TanStack passthrough options. For anything beyond these (`select`,
 * `placeholderData`, ...), compose the `objectQuery*Options` factories with
 * `useQuery` directly.
 */
type QueryHookExtras = {
  enabled?: boolean
  staleTime?: number
  gcTime?: number
  refetchInterval?: number | false
  refetchOnWindowFocus?: boolean
  retry?: boolean | number
}

/**
 * Executor bound to the nearest `SixbProvider` client, or the global client.
 * Hooks run the query IR through this, so the binding a query was built with
 * (`objects(Type, { client })`) does not apply inside hooks.
 */
function useClientQueryExecutor(): ObjectQueryExecutor {
  const client = useContext(SixbClientContext)
  return useMemo(() => createHttpQueryExecutor(client), [client])
}

export function useObjectsQuery<TBuilt extends { readonly ir: ObjectQuery }>(
  query: TBuilt,
  options?: QueryHookExtras
): UseQueryResult<ListResult<BuiltRow<TBuilt>>, Error> {
  const executor = useClientQueryExecutor()
  const ir = query.ir
  return useQuery({
    queryKey: objectQueryKey("query", ir),
    queryFn: async () => {
      const result = await executor.list(ir)
      return {
        objects: [...result.objects],
        hasMore: result.hasMore,
        nextPageToken: result.nextPageToken,
        total: result.total ?? result.objects.length,
      } as ListResult<BuiltRow<TBuilt>>
    },
    ...options,
  })
}

export function useObjectsCount(
  query: { readonly ir: ObjectQuery },
  options?: QueryHookExtras
): UseQueryResult<number, Error> {
  const executor = useClientQueryExecutor()
  const ir = query.ir
  return useQuery({
    queryKey: objectQueryKey("count", ir),
    queryFn: () => executor.count(ir),
    ...options,
  })
}

export function useObjectsExists(
  query: { readonly ir: ObjectQuery },
  options?: QueryHookExtras
): UseQueryResult<boolean, Error> {
  const executor = useClientQueryExecutor()
  const ir = query.ir
  return useQuery({
    queryKey: objectQueryKey("exists", ir),
    queryFn: () => executor.exists(ir),
    ...options,
  })
}

export function useObjectsFacets(
  query: { readonly ir: ObjectQuery },
  // Loosely token-typed: tying this to the built query's facet input would
  // require inference through the builder, which the ontology validates
  // server-side anyway.
  facets: readonly { property: { id: string }; limit: number }[],
  options?: QueryHookExtras
): UseQueryResult<ObjectQueryFacetResult[], Error> {
  const executor = useClientQueryExecutor()
  const ir = query.ir
  const facetRequests = facets.map((facet) => ({
    propertyId: facet.property.id,
    limit: facet.limit,
  }))
  return useQuery({
    queryKey: objectQueryKey("facets", ir, facetRequests),
    queryFn: () => executor.facets(ir, facetRequests),
    ...options,
  })
}

export function useObjectsInfinite<TBuilt extends { readonly ir: ObjectQuery }>(
  query: TBuilt,
  options: {
    pageSize: number
    enabled?: boolean
    staleTime?: number
    gcTime?: number
    refetchInterval?: number | false
  }
) {
  const { pageSize, ...extras } = options
  const executor = useClientQueryExecutor()
  const ir = query.ir
  return useInfiniteQuery({
    queryKey: objectQueryKey("infinite", ir, pageSize),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const result = await executor.list(
        { kind: "page", pageSize, pageToken: pageParam, input: ir },
        { includeTotal: false }
      )
      return {
        objects: [...result.objects],
        hasMore: result.hasMore,
        nextPageToken: result.nextPageToken,
      } as ListResultWithoutTotal<BuiltRow<TBuilt>>
    },
    getNextPageParam: (lastPage) => lastPage.nextPageToken,
    ...extras,
  })
}
