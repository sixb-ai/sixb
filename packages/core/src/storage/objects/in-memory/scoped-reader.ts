import { hasVectorProfile } from "../../../objects/vectors/query"
import {
  assertObjectReadFacetCount,
  assertObjectReadOutputWithinLimit,
  type ObjectReadExecutionLimits,
} from "../execution-limits"
import { type ObjectBatchKey, objectBatchKey } from "../keys"
import { assertObjectReaderProject } from "../read-scope"
import type {
  CountObjectsInput,
  ExistsObjectsInput,
  FacetObjectsInput,
  LinkDirection,
  ObjectLinkRow,
  ObjectQueryCapabilities,
  ObjectReadStorage,
  ObjectRow,
  QueryObjectsInput,
} from "../types"
import { fullLinkRowKey } from "./keys"
import {
  buildFacetResults,
  collectLinksBatch,
  evaluateObjectQuery,
  queryLinksFrom,
  stripOuterRowShape,
} from "./query"
import type { InMemoryScopedReadSource } from "./read-source"

/**
 * Answer every terminal from what a scope leaves visible, resolved again for each operation so
 * reads stay live. Rows leave detached; output budgets apply when the scope carries them.
 */
export function createInMemoryScopedReader(params: {
  projectId: string
  resolve: () => InMemoryScopedReadSource
  limits?: ObjectReadExecutionLimits
  queryCapabilities: () => ObjectQueryCapabilities
}): ObjectReadStorage {
  const { projectId, resolve, limits, queryCapabilities } = params
  const assertProject = (actualProjectId: string) =>
    assertObjectReaderProject(projectId, actualProjectId)
  const visible = <T>(value: T): T => {
    if (limits) assertObjectReadOutputWithinLimit(value, limits)
    return value
  }
  const visibleMap = <TKey, TValue>(value: Map<TKey, TValue>): Map<TKey, TValue> => {
    if (limits) assertObjectReadOutputWithinLimit([...value.entries()], limits)
    return value
  }
  const selectsObjectProperties: ObjectReadStorage["selectsObjectProperties"] = async (input) => {
    assertProject(input.projectId)
    const source = resolve()
    return visible(
      input.items.map((item) =>
        source.selectsProperty(item.objectTypeId, item.primaryId, item.propertyId)
      )
    )
  }

  return Object.freeze({
    queryCapabilities,
    queryObjects: async (input: QueryObjectsInput) => {
      assertProject(input.projectId)
      const result = evaluateObjectQuery(input.query, resolve())
      return visible({
        objects: result.entries.map((entry) => ({
          ...structuredClone(entry.row),
          ...(hasVectorProfile(input.query) ? { score: entry.score } : {}),
        })),
        hasMore: result.hasMore,
        nextPageToken: result.nextPageToken,
        ...(input.includeTotal === false ? {} : { total: result.total }),
      })
    },
    countObjects: async (input: CountObjectsInput) => {
      assertProject(input.projectId)
      return visible({
        count: evaluateObjectQuery(stripOuterRowShape(input.query), resolve()).total,
      })
    },
    existsObjects: async (input: ExistsObjectsInput) => {
      assertProject(input.projectId)
      return visible({
        exists: evaluateObjectQuery(stripOuterRowShape(input.query), resolve()).total > 0,
      })
    },
    facetObjects: async (input: FacetObjectsInput) => {
      assertProject(input.projectId)
      assertObjectReadFacetCount(input.facets.length)
      const result = evaluateObjectQuery(stripOuterRowShape(input.query), resolve())
      return visible(
        structuredClone({
          total: result.entries.length,
          facets: buildFacetResults(
            result.entries.map((entry) => entry.row),
            input.facets
          ),
        })
      )
    },
    getByPrimaryId: async (input) => {
      assertProject(input.projectId)
      const row = resolve().getObject(input.objectTypeId, input.primaryId)
      return visible(row ? structuredClone(row) : null)
    },
    getByUniqueValue: async (input) => {
      assertProject(input.projectId)
      const source = resolve()
      const holder = source.uniqueHolder(input)
      const row = holder === undefined ? undefined : source.getObject(input.objectTypeId, holder)
      return visible(row ? structuredClone(row) : null)
    },
    selectsObjectProperties,
    listLinks: async (input) => {
      assertProject(input.projectId)
      return visible(listScopedLinks(resolve(), input).map((row) => structuredClone(row)))
    },
    getByPrimaryIdBatch: async (input) => {
      assertProject(input.projectId)
      const source = resolve()
      const rows = new Map<ObjectBatchKey, ObjectRow>()
      for (const item of input.items) {
        const row = source.getObject(item.objectTypeId, item.primaryId)
        if (row) {
          rows.set(objectBatchKey(item.objectTypeId, item.primaryId), structuredClone(row))
        }
      }
      return visibleMap(rows)
    },
    listLinksBatch: async (input) => {
      assertProject(input.projectId)
      const source = resolve()
      return visibleMap(
        collectLinksBatch(
          {
            all: () => source.allLinks(),
            outgoing: (item) => source.outgoingLinks(item.objectTypeId, item.objectId),
          },
          input,
          true
        )
      )
    },
    queryLinks: async (input) => {
      assertProject(input.projectId)
      const source = resolve()
      return visible(
        structuredClone(await queryLinksFrom(input, (item) => listScopedLinks(source, item)))
      )
    },
    list: async (input) => {
      assertProject(input.projectId)
      return visible(listRows(input, [...resolve().allObjects()]))
    },
  } satisfies ObjectReadStorage)
}

function listScopedLinks(
  source: InMemoryScopedReadSource,
  params: {
    readonly projectId: string
    readonly objectTypeId: string
    readonly objectId: string
    readonly linkId?: string
    readonly direction?: LinkDirection
  }
): ObjectLinkRow[] {
  const direction = params.direction ?? "outgoing"
  const matches = (row: ObjectLinkRow) => !params.linkId || row.linkId === params.linkId
  const rows: ObjectLinkRow[] = []

  if (direction === "outgoing" || direction === "both") {
    for (const row of source.outgoingLinks(params.objectTypeId, params.objectId)) {
      if (matches(row)) rows.push(row)
    }
  }
  if (direction === "incoming" || direction === "both") {
    for (const row of source.allLinks()) {
      if (
        row.targetTypeId === params.objectTypeId &&
        row.targetId === params.objectId &&
        matches(row)
      ) {
        rows.push(row)
      }
    }
  }

  if (direction !== "both") return rows
  return [...new Map(rows.map((row) => [fullLinkRowKey(row), row])).values()]
}

function listRows(
  params: Parameters<ObjectReadStorage["list"]>[0],
  candidates: readonly ObjectRow[]
): { objects: readonly ObjectRow[]; hasMore: boolean; total: number } {
  const requestedTypes =
    params.objectTypeId === undefined
      ? undefined
      : new Set(
          typeof params.objectTypeId === "string" ? [params.objectTypeId] : params.objectTypeId
        )
  let rows = candidates.filter(
    (row) =>
      row.projectId === params.projectId &&
      (!requestedTypes || requestedTypes.has(row.objectTypeId))
  )

  rows = rows.filter(
    (row) =>
      (!params.primaryIdPrefix || row.primaryId.startsWith(params.primaryIdPrefix)) &&
      (!params.primaryIdSuffix || row.primaryId.endsWith(params.primaryIdSuffix)) &&
      (!params.updatedAfter || row.updatedAt >= params.updatedAfter) &&
      (!params.updatedBefore || row.updatedAt <= params.updatedBefore) &&
      (!params.createdAfter || row.createdAt >= params.createdAfter) &&
      (!params.createdBefore || row.createdAt <= params.createdBefore)
  )

  const total = rows.length
  const offset = params.offset ?? 0
  const limit = params.limit ?? 50
  if (limit === 0) return { objects: [], hasMore: offset < total, total }

  const orderBy = params.orderBy ?? "updatedAt"
  const order = params.order ?? "desc"
  rows.sort((left, right) => {
    const comparison =
      orderBy === "primaryId"
        ? left.primaryId.localeCompare(right.primaryId)
        : orderBy === "createdAt"
          ? left.createdAt.getTime() - right.createdAt.getTime()
          : left.updatedAt.getTime() - right.updatedAt.getTime()
    return order === "desc" ? -comparison : comparison
  })

  const objects = rows.slice(offset, offset + limit).map((row) => structuredClone(row))
  return {
    objects,
    hasMore: offset + limit < total,
    total,
  }
}
