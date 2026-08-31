/**
 * TanStack Query integration for typed object queries.
 *
 * Layer 1: `objectQuery*Options` factories for prefetching, loaders, and SSR.
 * Layer 2: `useObjects*` hooks for components. Both key on the normalized
 * query IR, so identical queries share cache entries — inline builders are
 * safe to construct on every render.
 */
import type { FileRef, InferPropertyValue, Property, TelemetryPropertyToken } from "@sixb/core"
import type {
  ListResult,
  ListResultWithoutTotal,
  ObjectQuery,
  ObjectQueryExecutor,
  ObjectQueryExecutorFacetRequest,
  ObjectQueryFacetResult,
  ObjectQueryListOptions,
  ObjectTypeWithPropertyTokens,
} from "@sixb/core/query"
import {
  infiniteQueryOptions,
  type QueryClient,
  queryOptions,
  type UseMutationOptions,
  type UseMutationResult,
  type UseQueryResult,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { useMemo } from "react"
import {
  type ActionRunDetail,
  ActionRunFailedError,
  type ActionWaitOptions,
  type RequestActionAndWaitInput,
  requestActionAndWait,
} from "./actions"
import { SixbProvider, useSixbProviderClient } from "./client-provider"
import { type SixbFileUploadError, type UploadFileInput, uploadFile } from "./file"
import {
  getActionRunQueryKey,
  listActionRunsInfiniteQueryKey,
  listActionRunsQueryKey,
} from "./generated/@tanstack/react-query.gen"
import type { Client } from "./generated/client"
import { getBulkTelemetryHistory, getTelemetryHistory, type Options } from "./generated/sdk.gen"
import type {
  GetBulkTelemetryHistoryData,
  GetTelemetryHistoryData,
  RequestActionData,
} from "./generated/types.gen"
import { createHttpQueryExecutor } from "./query"

const objectQueryBaseKey = ["sixb", "objects"] as const

export type ObjectQueryKeyScope = "query" | "count" | "exists" | "facets" | "infinite"

export type ObjectQueryBaseKey = typeof objectQueryBaseKey

export type ObjectQueryKey = readonly ["sixb", "objects", ObjectQueryKeyScope, ObjectQuery, unknown]

export type ObjectQueryLike = {
  readonly ir: ObjectQuery
}

export type ObjectQueryFacetKeyInput =
  | ObjectQueryExecutorFacetRequest
  | {
      readonly property: { readonly id: string }
      readonly limit: number
    }

export interface ObjectQueryInfiniteKeyOptions {
  readonly pageSize: number
}

type ObjectQueryInvalidationClient = Pick<QueryClient, "invalidateQueries">

function objectQueryKey(scope: ObjectQueryKeyScope, ir: ObjectQuery, extra?: unknown) {
  return [...objectQueryBaseKey, scope, ir, extra ?? null] as const
}

function objectQueryFacetKey(
  facets: readonly ObjectQueryFacetKeyInput[]
): ObjectQueryExecutorFacetRequest[] {
  return facets.map((facet) => ({
    propertyId: "propertyId" in facet ? facet.propertyId : facet.property.id,
    limit: facet.limit,
  }))
}

export const objectQueryKeys = {
  all(): ObjectQueryBaseKey {
    return objectQueryBaseKey
  },

  list(query: ObjectQueryLike, options?: ObjectQueryListOptions): ObjectQueryKey {
    return objectQueryKey("query", query.ir, options)
  },

  count(query: ObjectQueryLike): ObjectQueryKey {
    return objectQueryKey("count", query.ir)
  },

  exists(query: ObjectQueryLike): ObjectQueryKey {
    return objectQueryKey("exists", query.ir)
  },

  facets(query: ObjectQueryLike, facets: readonly ObjectQueryFacetKeyInput[]): ObjectQueryKey {
    return objectQueryKey("facets", query.ir, objectQueryFacetKey(facets))
  },

  infinite(query: ObjectQueryLike, options: ObjectQueryInfiniteKeyOptions): ObjectQueryKey {
    return objectQueryKey("infinite", query.ir, options.pageSize)
  },
} as const

export function invalidateObjectQueries(queryClient: ObjectQueryInvalidationClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: objectQueryKeys.all() })
}

export function invalidateObjectQuery(
  queryClient: ObjectQueryInvalidationClient,
  query: ObjectQueryLike,
  options?: ObjectQueryListOptions
): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: objectQueryKeys.list(query, options),
    exact: true,
  })
}

export function invalidateObjectCountQuery(
  queryClient: ObjectQueryInvalidationClient,
  query: ObjectQueryLike
): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: objectQueryKeys.count(query),
    exact: true,
  })
}

export function invalidateObjectExistsQuery(
  queryClient: ObjectQueryInvalidationClient,
  query: ObjectQueryLike
): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: objectQueryKeys.exists(query),
    exact: true,
  })
}

export function invalidateObjectFacetsQuery(
  queryClient: ObjectQueryInvalidationClient,
  query: ObjectQueryLike,
  facets: readonly ObjectQueryFacetKeyInput[]
): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: objectQueryKeys.facets(query, facets),
    exact: true,
  })
}

export function invalidateObjectInfiniteQuery(
  queryClient: ObjectQueryInvalidationClient,
  query: ObjectQueryLike,
  options: ObjectQueryInfiniteKeyOptions
): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: objectQueryKeys.infinite(query, options),
    exact: true,
  })
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
    queryKey: objectQueryKeys.list(query, options),
    queryFn: () => query.list(options),
  })
}

export function objectQueryCountOptions(query: {
  readonly ir: ObjectQuery
  count(): Promise<number>
}) {
  return queryOptions({
    queryKey: objectQueryKeys.count(query),
    queryFn: () => query.count(),
  })
}

export function objectQueryExistsOptions(query: {
  readonly ir: ObjectQuery
  exists(): Promise<boolean>
}) {
  return queryOptions({
    queryKey: objectQueryKeys.exists(query),
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
    queryKey: objectQueryKeys.facets(query, facets as readonly ObjectQueryFacetKeyInput[]),
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
    queryKey: objectQueryKeys.infinite(query, options),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      query.page({ pageSize: options.pageSize, pageToken: pageParam }).list({
        includeTotal: false,
      }),
    getNextPageParam: (lastPage) => lastPage.nextPageToken,
  })
}

export { SixbProvider }

export type UseUploadFileInput = UploadFileInput

export function useUploadFile(): UseMutationResult<
  FileRef,
  SixbFileUploadError,
  UseUploadFileInput
> {
  const client = useSixbProviderClient()

  return useMutation({
    mutationFn: ({
      file,
      fetch,
      fileName,
      logicalPath,
      client: inputClient,
      stagedUploadThresholdBytes,
      signal,
    }) =>
      uploadFile(file, {
        client: inputClient ?? client,
        fetch,
        fileName,
        logicalPath,
        stagedUploadThresholdBytes,
        signal,
      }),
  })
}

export type ActionRunMutationWireSubject = NonNullable<RequestActionData["body"]["subject"]>

export type ActionRunMutationObjectSubject<
  TObjectType extends ObjectTypeWithPropertyTokens = ObjectTypeWithPropertyTokens,
> = {
  readonly objectType: TObjectType
  readonly primaryId: string
}

export type ActionRunMutationSubject = ActionRunMutationWireSubject | ActionRunMutationObjectSubject

type ActionRunMutationRequestBody = Omit<RequestActionAndWaitInput["body"], "subject"> & {
  readonly subject?: ActionRunMutationSubject
}

export type ActionRunMutationRequest = Omit<RequestActionAndWaitInput, "body"> & {
  readonly body: ActionRunMutationRequestBody
}

export interface ActionRunMutationBaseOptions<TVariables, TContext>
  extends ActionWaitOptions,
    Omit<UseMutationOptions<ActionRunDetail, Error, TVariables, TContext>, "mutationFn"> {
  /** hey-api client override. Defaults to the nearest SixbProvider client, then the global client. */
  readonly client?: Client
  /** Invalidate action-run caches, and object-query caches when the terminal run committed changes. */
  readonly invalidateOnCommit?: boolean
  /** Override used by tests and non-hook option factory consumers. */
  readonly queryClient?: QueryClient
}

export interface ConfiguredActionRunMutationOptions<
  TParams extends Record<string, unknown> = Record<string, unknown>,
  TContext = unknown,
> extends ActionRunMutationBaseOptions<TParams | undefined, TContext> {
  readonly actionId: string
  readonly subject?: ActionRunMutationSubject
  readonly runId?: string
}

export interface DynamicActionRunMutationOptions<TContext = unknown>
  extends ActionRunMutationBaseOptions<ActionRunMutationRequest, TContext> {
  readonly actionId?: never
  readonly subject?: never
  readonly runId?: never
}

type InternalActionRunMutationOptions<TVariables, TContext> = ActionRunMutationBaseOptions<
  TVariables,
  TContext
> & {
  readonly actionId?: string
  readonly subject?: ActionRunMutationSubject
  readonly runId?: string
}

export function actionRunMutationOptions<
  TParams extends Record<string, unknown> = Record<string, unknown>,
  TContext = unknown,
>(
  options: ConfiguredActionRunMutationOptions<TParams, TContext>
): UseMutationOptions<ActionRunDetail, Error, TParams | undefined, TContext>
export function actionRunMutationOptions<TContext = unknown>(
  options?: DynamicActionRunMutationOptions<TContext>
): UseMutationOptions<ActionRunDetail, Error, ActionRunMutationRequest, TContext>
export function actionRunMutationOptions<TVariables, TContext>(
  options?: InternalActionRunMutationOptions<TVariables, TContext>
): UseMutationOptions<ActionRunDetail, Error, TVariables, TContext> {
  return createActionRunMutationOptions(options)
}

function createActionRunMutationOptions<TVariables, TContext>(
  options?: InternalActionRunMutationOptions<TVariables, TContext>
): UseMutationOptions<ActionRunDetail, Error, TVariables, TContext> {
  const {
    actionId,
    subject,
    runId,
    timeoutMs,
    fallbackPollIntervalMs,
    disconnectedPollIntervalMs,
    signal,
    rejectOnTerminalFailure,
    client,
    invalidateOnCommit = false,
    queryClient,
    onSuccess,
    onError,
    ...mutationOptions
  } = options ?? {}

  const waitOptions: ActionWaitOptions = {
    timeoutMs,
    fallbackPollIntervalMs,
    disconnectedPollIntervalMs,
    signal,
    rejectOnTerminalFailure,
  }

  return {
    ...mutationOptions,
    mutationFn: (variables) =>
      requestActionAndWait(
        buildActionRunMutationRequest(variables, {
          actionId,
          subject,
          runId,
          client,
          waitOptions,
        })
      ),
    onSuccess: async (run, variables, context, mutation) => {
      if (invalidateOnCommit && queryClient) {
        await invalidateActionRunMutationCaches(queryClient, run)
      }
      await onSuccess?.(run, variables, context, mutation)
    },
    onError: async (error, variables, context, mutation) => {
      if (invalidateOnCommit && queryClient && error instanceof ActionRunFailedError) {
        await invalidateActionRunMutationCaches(queryClient, error.run)
      }
      await onError?.(error, variables, context, mutation)
    },
  }
}

export function useActionRunMutation<
  TParams extends Record<string, unknown> = Record<string, unknown>,
  TContext = unknown,
>(
  options: ConfiguredActionRunMutationOptions<TParams, TContext>
): UseMutationResult<ActionRunDetail, Error, TParams | undefined, TContext>
export function useActionRunMutation<TContext = unknown>(
  options?: DynamicActionRunMutationOptions<TContext>
): UseMutationResult<ActionRunDetail, Error, ActionRunMutationRequest, TContext>
export function useActionRunMutation<TVariables, TContext>(
  options?: InternalActionRunMutationOptions<TVariables, TContext>
): UseMutationResult<ActionRunDetail, Error, TVariables, TContext> {
  const providerClient = useSixbProviderClient()
  const queryClient = useQueryClient()
  return useMutation(
    createActionRunMutationOptions({
      ...options,
      client: options?.client ?? providerClient,
      queryClient: options?.queryClient ?? queryClient,
    } as InternalActionRunMutationOptions<TVariables, TContext>)
  ) as UseMutationResult<ActionRunDetail, Error, TVariables, TContext>
}

function buildActionRunMutationRequest<TVariables>(
  variables: TVariables,
  options: {
    readonly actionId?: string
    readonly subject?: ActionRunMutationSubject
    readonly runId?: string
    readonly client?: Client
    readonly waitOptions: ActionWaitOptions
  }
): RequestActionAndWaitInput {
  if (options.actionId) {
    const params = variables === undefined ? undefined : (variables as Record<string, unknown>)
    const subject = normalizeActionRunMutationSubject(options.subject)
    return {
      ...options.waitOptions,
      client: options.client,
      path: { actionId: options.actionId },
      body: {
        ...(subject ? { subject } : {}),
        ...(params ? { params } : {}),
        ...(options.runId ? { runId: options.runId } : {}),
      },
    }
  }

  if (isActionRunMutationRequest(variables)) {
    const subject = normalizeActionRunMutationSubject(variables.body.subject)
    return {
      ...options.waitOptions,
      client: options.client,
      ...variables,
      body: {
        ...(subject ? { subject } : {}),
        ...(variables.body.params ? { params: variables.body.params } : {}),
        ...(variables.body.runId ? { runId: variables.body.runId } : {}),
      },
    }
  }

  throw new Error(
    "[SixbClient] useActionRunMutation() without an actionId requires full request options."
  )
}

function normalizeActionRunMutationSubject(
  subject: ActionRunMutationSubject | undefined
): ActionRunMutationWireSubject | undefined {
  if (!subject) {
    return undefined
  }

  if ("objectType" in subject) {
    return {
      kind: "object",
      objectTypeId: subject.objectType.id,
      primaryId: subject.primaryId,
    }
  }

  return subject
}

function isActionRunMutationRequest(value: unknown): value is ActionRunMutationRequest {
  return (
    isRecord(value) &&
    isRecord(value.path) &&
    typeof value.path.actionId === "string" &&
    isRecord(value.body)
  )
}

async function invalidateActionRunMutationCaches(
  queryClient: Pick<QueryClient, "invalidateQueries">,
  run: ActionRunDetail
): Promise<void> {
  const invalidations: Promise<unknown>[] = [
    queryClient.invalidateQueries({
      queryKey: getActionRunQueryKey({ path: { runId: run.id } }),
      exact: true,
    }),
    queryClient.invalidateQueries({ queryKey: listActionRunsQueryKey() }),
    queryClient.invalidateQueries({ queryKey: listActionRunsInfiniteQueryKey() }),
  ]

  // A run that reached the commit phase may have changed any object the action touched. The run
  // record no longer carries a per-object diff — object changes live in the authoritative ontology
  // commit — so object reads are invalidated wholesale.
  if (run.phase === "commit" || run.phase === "effects") {
    invalidations.push(
      invalidateObjectQueries(queryClient),
      queryClient.invalidateQueries({ predicate: isGeneratedObjectRead })
    )
  }

  await Promise.all(invalidations)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/** Matches every generated single-object read, regardless of object type or id. */
function isGeneratedObjectRead(query: { readonly queryKey: readonly unknown[] }): boolean {
  const [descriptor] = query.queryKey
  return isRecord(descriptor) && descriptor._id === "getObject"
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
      } & (NonNullable<TRow> extends { links: infer TLinks } ? { links: TLinks } : unknown)
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
  const client = useSixbProviderClient()
  return useMemo(() => createHttpQueryExecutor(client), [client])
}

export function useTelemetryHistoryQuery<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TProperty extends TelemetryPropertyToken<TObjectType>,
>(
  options: TelemetryHistoryHookOptions<TObjectType, TProperty>
): UseQueryResult<TelemetryHistoryPoints<TProperty>, Error> {
  const client = useSixbProviderClient()
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
  const client = useSixbProviderClient()
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
    queryKey: objectQueryKeys.list(query),
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
    queryKey: objectQueryKeys.count(query),
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
    queryKey: objectQueryKeys.exists(query),
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
    queryKey: objectQueryKeys.facets(query, facets),
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
    queryKey: objectQueryKeys.infinite(query, { pageSize }),
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
