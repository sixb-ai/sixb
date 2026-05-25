import { queryOptions } from "@tanstack/react-query"
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
export * from "./generated/@tanstack/react-query.gen"
export {
  createParioEventsWebSocketUrl,
  type UseParioEventsOptions,
  type UseParioEventsResult,
  useParioEvents,
} from "./useParioEvents"

type QueryKey = readonly [
  {
    _id: string
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
      const { data: objectsResponse } = await listObjects({
        query: {
          limit: "500",
          orderBy: "updatedAt",
          order: "desc",
        },
        throwOnError: true,
      })

      const objects = objectsResponse?.objects ?? []
      if (objects.length === 0) {
        return []
      }

      const linksByKey = new Map<string, RelationshipEdge>()
      const linkResponses = await Promise.all(
        objects.map(async (object) => {
          try {
            const { data } = await listObjectLinks({
              path: {
                objectTypeId: object.objectTypeId,
                objectId: object.primaryId,
              },
              throwOnError: true,
            })
            return data ?? []
          } catch {
            return []
          }
        })
      )

      for (const links of linkResponses) {
        for (const link of links) {
          const source = encodeObjectId(link.sourceTypeId, link.sourceId)
          const target = encodeObjectId(link.targetTypeId, link.targetId)
          const key = `${source}|${target}|${link.linkId}`

          linksByKey.set(key, {
            source,
            target,
            type: link.linkId,
            properties: link.properties,
          })
        }
      }

      const all = Array.from(linksByKey.values())
      const objectId = options?.query?.objectId
      if (!objectId) {
        return all
      }

      return all.filter((edge) => edge.source === objectId || edge.target === objectId)
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

async function fetchObjectListPage(options?: ListObjectsOptions): Promise<ObjectListPage> {
  const { path: _path, query, ...rest } = options ?? {}
  const [objectTypeMap, objectsResponse] = await Promise.all([
    fetchObjectTypeMap(),
    listObjects({
      ...rest,
      query: buildListObjectsQuery(query),
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
    limit?: string | number
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
      const rangeStart = new Date(now.getTime() - (duration ?? 5 * 60_000)).toISOString()
      const rangeEnd = now.toISOString()

      const { data } = await getTelemetryHistory({
        path: {
          objectTypeId: parsed.objectTypeId,
          objectId: parsed.primaryId,
          propertyId: options.path.propertyId,
        },
        query: {
          from: rangeStart,
          to: rangeEnd,
          order: "asc",
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
