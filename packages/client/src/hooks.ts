import { type InfiniteData, infiniteQueryOptions, queryOptions } from "@tanstack/react-query"
import {
  getObject,
  getTelemetryHistory,
  listObjectLinks,
  listObjects,
  listObjectTypes,
  type Options,
} from "./generated/sdk.gen"
import type { GetObjectData, GetTelemetryHistoryData, ListObjectsData } from "./generated/types.gen"
import {
  decodeObjectId,
  encodeObjectId,
  type ObjectSummary,
  type RelationshipEdge,
  toObjectDetail,
  toObjectSummary,
  toTelemetryHistoryWithRange,
} from "./models"

export * from "./events"
export * from "./events-hooks"
export * from "./generated/@tanstack/react-query.gen"
export * from "./query-hooks"
export {
  createSixbEventsWebSocketUrl,
  type UseSixbEventsOptions,
  type UseSixbEventsResult,
  useSixbEvents,
} from "./useSixbEvents"

type QueryKey = readonly [
  {
    _id: string
    _infinite?: boolean
    path?: Record<string, unknown>
    query?: Record<string, unknown>
  },
]

function createQueryKey(
  id: string,
  options?: {
    path?: Record<string, unknown>
    query?: Record<string, unknown>
  }
): QueryKey {
  return [
    {
      _id: id,
      path: options?.path,
      query: options?.query,
    },
  ] as const
}

function parseDurationMs(input: string): number | null {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(input.trim())
  if (!match) return null

  const value = Number.parseInt(match[1], 10)
  const unit = match[2]

  if (unit === "ms") return value
  if (unit === "s") return value * 1000
  if (unit === "m") return value * 60_000
  if (unit === "h") return value * 3_600_000
  if (unit === "d") return value * 86_400_000
  return null
}

function parseLimit(value: string | number | undefined): string | undefined {
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

function toHistoryDate(value: Date | string | undefined): string | undefined {
  if (value === undefined) return undefined

  const date = typeof value === "string" ? new Date(value) : value
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function parseOffset(value: string | undefined): number {
  if (value === undefined) return 0

  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

async function loadObjectTypeMap() {
  const { data } = await listObjectTypes({ throwOnError: true })
  return new Map((data ?? []).map((objectType) => [objectType.id, objectType]))
}

let objectTypeMapPromise: ReturnType<typeof loadObjectTypeMap> | null = null

async function fetchObjectTypeMap() {
  objectTypeMapPromise ??= loadObjectTypeMap()
  try {
    return await objectTypeMapPromise
  } catch (error) {
    objectTypeMapPromise = null
    throw error
  }
}

export interface ListRelationshipsOptions {
  path?: {
    projectName?: string
  }
  query?: {
    objectId?: string
  }
}

export const listRelationshipsQueryKey = (options?: ListRelationshipsOptions): QueryKey => {
  return createQueryKey("listRelationships", {
    path: options?.path,
    query: options?.query,
  })
}

export const listRelationshipsOptions = (options?: ListRelationshipsOptions) => {
  return queryOptions({
    queryKey: listRelationshipsQueryKey(options),
    queryFn: async (): Promise<RelationshipEdge[]> => {
      const objectId = options?.query?.objectId
      const requestedObject = objectId ? decodeObjectId(objectId) : null
      if (!requestedObject) return []

      const { data = [] } = await listObjectLinks({
        path: {
          objectTypeId: requestedObject.objectTypeId,
          objectId: requestedObject.primaryId,
        },
        query: {
          direction: "both",
        },
        throwOnError: true,
      })

      return data.map((link) => ({
        source: encodeObjectId(link.sourceTypeId, link.sourceId),
        target: encodeObjectId(link.targetTypeId, link.targetId),
        type: link.linkId,
        properties: link.properties,
      }))
    },
  })
}

export interface ListObjectsOptions extends Omit<Options<ListObjectsData>, "path"> {
  path?: {
    projectName?: string
  }
}

export interface ObjectListPage {
  objects: ObjectSummary[]
  hasMore: boolean
  total: number
}

function buildListObjectsQuery(query: ListObjectsOptions["query"] | undefined) {
  return {
    limit: query?.limit ?? "300",
    orderBy: query?.orderBy ?? "updatedAt",
    order: query?.order ?? "desc",
    objectTypeId: query?.objectTypeId,
    idPrefix: query?.idPrefix,
    idSuffix: query?.idSuffix,
    updatedAfter: query?.updatedAfter,
    updatedBefore: query?.updatedBefore,
    createdAfter: query?.createdAfter,
    createdBefore: query?.createdBefore,
    offset: query?.offset,
  }
}

export const listObjectsQueryKey = (options?: ListObjectsOptions): QueryKey => {
  return createQueryKey("listObjects", {
    path: options?.path,
    query: options?.query as Record<string, unknown> | undefined,
  })
}

export const listObjectsPageQueryKey = (options?: ListObjectsOptions): QueryKey => {
  return createQueryKey("listObjectsPage", {
    path: options?.path,
    query: options?.query as Record<string, unknown> | undefined,
  })
}

async function fetchObjectListPage(
  options?: ListObjectsOptions,
  offsetOverride?: string
): Promise<ObjectListPage> {
  const { path: _path, query, ...rest } = options ?? {}
  const [objectTypeMap, objectsResponse] = await Promise.all([
    fetchObjectTypeMap(),
    listObjects({
      ...rest,
      query: {
        ...buildListObjectsQuery(query),
        offset: offsetOverride ?? query?.offset,
      },
      throwOnError: true,
    }),
  ])

  const response = objectsResponse.data
  const rows = response?.objects ?? []
  return {
    objects: rows.map((object) => toObjectSummary(object, objectTypeMap.get(object.objectTypeId))),
    hasMore: response?.hasMore ?? false,
    total: response?.total ?? rows.length,
  }
}

export const listObjectsPageOptions = (options?: ListObjectsOptions) => {
  return queryOptions({
    queryKey: listObjectsPageQueryKey(options),
    queryFn: async () => fetchObjectListPage(options),
  })
}

export const listObjectsOptions = (options?: ListObjectsOptions) => {
  return queryOptions({
    queryKey: listObjectsQueryKey(options),
    queryFn: async () => (await fetchObjectListPage(options)).objects,
  })
}

export const objectCountQueryKey = (options?: ListObjectsOptions): QueryKey => {
  return createQueryKey("objectCount", {
    path: options?.path,
    query: options?.query as Record<string, unknown> | undefined,
  })
}

export const objectCountOptions = (options?: ListObjectsOptions) => {
  return queryOptions({
    queryKey: objectCountQueryKey(options),
    queryFn: async () => {
      const { path: _path, query, ...rest } = options ?? {}
      const { data } = await listObjects({
        ...rest,
        query: {
          ...buildListObjectsQuery(query),
          limit: "0",
          offset: undefined,
        },
        throwOnError: true,
      })

      return data?.total ?? 0
    },
  })
}

export type ListObjectSummariesPage = ObjectListPage

export const listObjectsInfiniteQueryKey = (options?: ListObjectsOptions): QueryKey => {
  const [key] = listObjectsQueryKey(options)
  return [{ ...key, _infinite: true }] as const
}

export const listObjectsInfiniteOptions = (options?: ListObjectsOptions) => {
  const initialOffsetParam = options?.query?.offset ?? "0"
  const initialOffset = parseOffset(initialOffsetParam)

  return infiniteQueryOptions<
    ListObjectSummariesPage,
    Error,
    InfiniteData<ListObjectSummariesPage>,
    QueryKey,
    string
  >({
    queryKey: listObjectsInfiniteQueryKey(options),
    initialPageParam: initialOffsetParam,
    getNextPageParam: (lastPage, pages) => {
      if (!lastPage.hasMore) return undefined
      return String(initialOffset + pages.reduce((total, page) => total + page.objects.length, 0))
    },
    queryFn: async ({ pageParam }) => {
      return await fetchObjectListPage(options, String(pageParam ?? initialOffsetParam))
    },
  })
}

export interface GetObjectOptions extends Omit<Options<GetObjectData>, "path"> {
  path: {
    projectName?: string
    objectId: string
  }
}

export const getObjectQueryKey = (options: GetObjectOptions): QueryKey => {
  return createQueryKey("getObject", {
    path: options.path,
    query: options.query as Record<string, unknown> | undefined,
  })
}

export const getObjectOptions = (options: GetObjectOptions) => {
  return queryOptions({
    queryKey: getObjectQueryKey(options),
    queryFn: async () => {
      const parsed = decodeObjectId(options.path.objectId)
      if (!parsed) {
        throw new Error(`Invalid object id: ${options.path.objectId}`)
      }

      const objectTypeMap = await fetchObjectTypeMap()
      const { data } = await getObject({
        path: {
          objectTypeId: parsed.objectTypeId,
          objectId: parsed.primaryId,
        },
        throwOnError: true,
      })

      return toObjectDetail(data, objectTypeMap.get(data.objectTypeId))
    },
  })
}

export interface GetTelemetryHistoryOptions
  extends Omit<Options<GetTelemetryHistoryData>, "path" | "query"> {
  path: {
    projectName?: string
    objectId: string
    propertyId: string
  }
  query?: {
    range?: string
    from?: Date | string
    to?: Date | string
    limit?: string | number
    order?: "asc" | "desc"
  }
}

export const getTelemetryHistoryQueryKey = (options: GetTelemetryHistoryOptions): QueryKey => {
  return createQueryKey("getTelemetryHistory", {
    path: options.path,
    query: options.query as Record<string, unknown> | undefined,
  })
}

export const getTelemetryHistoryOptions = (options: GetTelemetryHistoryOptions) => {
  return queryOptions({
    queryKey: getTelemetryHistoryQueryKey(options),
    queryFn: async () => {
      const parsed = decodeObjectId(options.path.objectId)
      if (!parsed) {
        throw new Error(`Invalid object id: ${options.path.objectId}`)
      }

      const now = new Date()
      const duration = options.query?.range ? parseDurationMs(options.query.range) : null
      const rangeStart =
        toHistoryDate(options.query?.from) ??
        new Date(now.getTime() - (duration ?? 5 * 60_000)).toISOString()
      const rangeEnd = toHistoryDate(options.query?.to) ?? now.toISOString()

      const { data } = await getTelemetryHistory({
        path: {
          objectTypeId: parsed.objectTypeId,
          objectId: parsed.primaryId,
          propertyId: options.path.propertyId,
        },
        query: {
          from: rangeStart,
          to: rangeEnd,
          order: options.query?.order ?? "asc",
          limit: parseLimit(options.query?.limit),
        },
        throwOnError: true,
      })

      return toTelemetryHistoryWithRange({
        objectId: options.path.objectId,
        propertyId: options.path.propertyId,
        history: data,
        rangeStart,
        rangeEnd,
      })
    },
  })
}
