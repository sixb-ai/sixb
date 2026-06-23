/**
 * TanStack Query integration for typed object queries.
 *
 * Layer 1: `objectQuery*Options` factories for prefetching, loaders, and SSR.
 * Layer 2: `useObjects*` hooks for components. Both key on the normalized
 * query IR, so identical queries share cache entries — inline builders are
 * safe to construct on every render.
 */
import type { InferPropertyValue, Property, TelemetryPropertyToken } from "@sixb/core"
import type {
  ListResult,
  ListResultWithoutTotal,
  ObjectQuery,
  ObjectQueryExecutor,
  ObjectQueryFacetResult,
  ObjectQueryListOptions,
  ObjectTypeWithPropertyTokens,
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
import { getBulkTelemetryHistory, getTelemetryHistory, type Options } from "./generated/sdk.gen"
import type { GetBulkTelemetryHistoryData, GetTelemetryHistoryData } from "./generated/types.gen"
import { createHttpQueryExecutor } from "./query"

const objectQueryBaseKey = ["sixb", "objects"] as const

function objectQueryKey(scope: string, ir: ObjectQuery, extra?: unknown) {
  return [...objectQueryBaseKey, scope, ir, extra ?? null] as const
}

const telemetryHistoryBaseKey = ["sixb", "telemetry", "history"] as const

function toTelemetryHistoryDate(value: Date | string | undefined): string | undefined {
  return value instanceof Date ? value.toISOString() : value
}

function toTelemetryHistoryLimit(value: number | string | undefined): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.trunc(value)).toString()
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed)) {
      return Math.max(1, parsed).toString()
    }
  }

  return undefined
}

function toBulkTelemetryHistoryLimit(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : undefined
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

export type TelemetryHistoryValue<
  TProperty extends { readonly property: Pick<Property, "schema" | "nullable"> },
> = InferPropertyValue<TProperty["property"]>

export interface TelemetryHistoryPoint<TValue> {
  readonly projectId: string
  readonly objectTypeId: string
  readonly objectId: string
  readonly propertyId: string
  readonly value: TValue
  readonly unit?: string
  readonly at: string
}

export type TelemetryHistoryPoints<
  TProperty extends { readonly property: Pick<Property, "schema" | "nullable"> },
> = readonly TelemetryHistoryPoint<TelemetryHistoryValue<TProperty>>[]

export interface BulkTelemetryHistorySeries<TValue> {
  readonly objectTypeId: string
  readonly objectId: string
  readonly propertyId: string
  readonly points: readonly TelemetryHistoryPoint<TValue>[]
}

export type BulkTelemetryHistory<
  TProperties extends readonly { readonly property: Pick<Property, "schema" | "nullable"> }[],
> = readonly BulkTelemetryHistorySeries<TelemetryHistoryValue<TProperties[number]>>[]

export interface TelemetryHistoryQueryOptions<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TProperty extends TelemetryPropertyToken<TObjectType> = TelemetryPropertyToken<TObjectType>,
> extends Omit<Options<GetTelemetryHistoryData>, "path" | "query"> {
  readonly objectType: TObjectType
  readonly objectId: string
  readonly property: TProperty & TelemetryPropertyToken<NoInfer<TObjectType>>
  readonly from?: Date | string
  readonly to?: Date | string
  readonly limit?: number | string
  readonly order?: "asc" | "desc"
}

export type TelemetryHistoryHookOptions<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TProperty extends TelemetryPropertyToken<TObjectType> = TelemetryPropertyToken<TObjectType>,
> = TelemetryHistoryQueryOptions<TObjectType, TProperty> & QueryHookExtras

export interface BulkTelemetryHistoryQueryOptions<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TProperties extends
    readonly TelemetryPropertyToken<TObjectType>[] = readonly TelemetryPropertyToken<TObjectType>[],
> extends Omit<Options<GetBulkTelemetryHistoryData>, "path" | "body"> {
  readonly objectType: TObjectType
  readonly objectIds: readonly string[]
  readonly properties: TProperties & readonly TelemetryPropertyToken<NoInfer<TObjectType>>[]
  readonly from?: Date | string
  readonly to?: Date | string
  readonly limit?: number
  readonly order?: "asc" | "desc"
}

export type BulkTelemetryHistoryHookOptions<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TProperties extends
    readonly TelemetryPropertyToken<TObjectType>[] = readonly TelemetryPropertyToken<TObjectType>[],
> = BulkTelemetryHistoryQueryOptions<TObjectType, TProperties> & QueryHookExtras

function telemetryHistoryPath<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TProperty extends TelemetryPropertyToken<TObjectType>,
>(options: TelemetryHistoryQueryOptions<TObjectType, TProperty>) {
  return {
    objectTypeId: options.objectType.id,
    objectId: options.objectId,
    propertyId: options.property.id,
  }
}

function telemetryHistoryQuery<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TProperty extends TelemetryPropertyToken<TObjectType>,
>(options: TelemetryHistoryQueryOptions<TObjectType, TProperty>) {
  return {
    from: toTelemetryHistoryDate(options.from),
    to: toTelemetryHistoryDate(options.to),
    limit: toTelemetryHistoryLimit(options.limit),
    order: options.order ?? "asc",
  }
}

export function telemetryHistoryQueryKey<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TProperty extends TelemetryPropertyToken<TObjectType>,
>(options: TelemetryHistoryQueryOptions<TObjectType, TProperty>) {
  return [
    ...telemetryHistoryBaseKey,
    telemetryHistoryPath(options),
    telemetryHistoryQuery(options),
  ] as const
}

async function fetchTelemetryHistory<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TProperty extends TelemetryPropertyToken<TObjectType>,
>(
  options: TelemetryHistoryQueryOptions<TObjectType, TProperty>,
  signal?: AbortSignal
): Promise<TelemetryHistoryPoints<TProperty>> {
  const path = telemetryHistoryPath(options)
  const query = telemetryHistoryQuery(options)
  const {
    objectType: _objectType,
    objectId: _objectId,
    property: _property,
    from: _from,
    to: _to,
    limit: _limit,
    order: _order,
    ...rest
  } = options

  const { data } = await getTelemetryHistory({
    ...rest,
    path,
    query,
    signal,
    responseStyle: "fields",
    throwOnError: true,
  })

  return data.map((point) => ({
    projectId: point.projectId,
    objectTypeId: point.objectTypeId,
    objectId: point.objectId,
    propertyId: point.propertyId,
    value: point.value as TelemetryHistoryValue<TProperty>,
    unit: point.unit,
    at: point.at,
  }))
}

function bulkTelemetryHistoryBody<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TProperties extends readonly TelemetryPropertyToken<TObjectType>[],
>(options: BulkTelemetryHistoryQueryOptions<TObjectType, TProperties>) {
  const propertyIds = options.properties.map((property) => property.id)
  return {
    series: options.objectIds.flatMap((objectId) =>
      propertyIds.map((propertyId) => ({
        objectTypeId: options.objectType.id,
        objectId,
        propertyId,
      }))
    ),
    from: toTelemetryHistoryDate(options.from),
    to: toTelemetryHistoryDate(options.to),
    limitPerSeries: toBulkTelemetryHistoryLimit(options.limit),
    order: options.order ?? "asc",
  }
}

export function bulkTelemetryHistoryQueryKey<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TProperties extends readonly TelemetryPropertyToken<TObjectType>[],
>(options: BulkTelemetryHistoryQueryOptions<TObjectType, TProperties>) {
  return [...telemetryHistoryBaseKey, "bulk", bulkTelemetryHistoryBody(options)] as const
}

async function fetchBulkTelemetryHistory<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TProperties extends readonly TelemetryPropertyToken<TObjectType>[],
>(
  options: BulkTelemetryHistoryQueryOptions<TObjectType, TProperties>,
  signal?: AbortSignal
): Promise<BulkTelemetryHistory<TProperties>> {
  const body = bulkTelemetryHistoryBody(options)
  const {
    objectType: _objectType,
    objectIds: _objectIds,
    properties: _properties,
    from: _from,
    to: _to,
    limit: _limit,
    order: _order,
    ...rest
  } = options

  const { data } = await getBulkTelemetryHistory({
    ...rest,
    body,
    signal,
    responseStyle: "fields",
    throwOnError: true,
  })

  return data.series.map((series) => ({
    objectTypeId: series.objectTypeId,
    objectId: series.objectId,
    propertyId: series.propertyId,
    points: series.points.map((point) => ({
      projectId: point.projectId,
      objectTypeId: point.objectTypeId,
      objectId: point.objectId,
      propertyId: point.propertyId,
      value: point.value as TelemetryHistoryValue<TProperties[number]>,
      unit: point.unit,
      at: point.at,
    })),
  }))
}

export function telemetryHistoryQueryOptions<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TProperty extends TelemetryPropertyToken<TObjectType>,
>(options: TelemetryHistoryQueryOptions<TObjectType, TProperty>) {
  return queryOptions({
    queryKey: telemetryHistoryQueryKey(options),
    queryFn: ({ signal }) => fetchTelemetryHistory(options, signal),
  })
}

export function bulkTelemetryHistoryQueryOptions<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TProperties extends readonly TelemetryPropertyToken<TObjectType>[],
>(options: BulkTelemetryHistoryQueryOptions<TObjectType, TProperties>) {
  return queryOptions({
    queryKey: bulkTelemetryHistoryQueryKey(options),
    queryFn: ({ signal }) => fetchBulkTelemetryHistory(options, signal),
  })
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

export function useTelemetryHistoryQuery<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TProperty extends TelemetryPropertyToken<TObjectType>,
>(
  options: TelemetryHistoryHookOptions<TObjectType, TProperty>
): UseQueryResult<TelemetryHistoryPoints<TProperty>, Error> {
  const client = useContext(SixbClientContext)
  const {
    enabled,
    staleTime,
    gcTime,
    refetchInterval,
    refetchOnWindowFocus,
    retry,
    ...historyOptions
  } = options

  const historyInput: TelemetryHistoryQueryOptions<TObjectType, TProperty> = {
    ...historyOptions,
    client: historyOptions.client ?? client,
  }

  return useQuery({
    ...telemetryHistoryQueryOptions(historyInput),
    enabled,
    staleTime,
    gcTime,
    refetchInterval,
    refetchOnWindowFocus,
    retry,
  })
}

export function useBulkTelemetryHistoryQuery<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TProperties extends readonly TelemetryPropertyToken<TObjectType>[],
>(
  options: BulkTelemetryHistoryHookOptions<TObjectType, TProperties>
): UseQueryResult<BulkTelemetryHistory<TProperties>, Error> {
  const client = useContext(SixbClientContext)
  const {
    enabled,
    staleTime,
    gcTime,
    refetchInterval,
    refetchOnWindowFocus,
    retry,
    ...historyOptions
  } = options

  const historyInput: BulkTelemetryHistoryQueryOptions<TObjectType, TProperties> = {
    ...historyOptions,
    client: historyOptions.client ?? client,
  }

  return useQuery({
    ...bulkTelemetryHistoryQueryOptions(historyInput),
    enabled,
    staleTime,
    gcTime,
    refetchInterval,
    refetchOnWindowFocus,
    retry,
  })
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
