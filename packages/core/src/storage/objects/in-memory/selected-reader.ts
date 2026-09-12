import {
  assertObjectReadFacetCount,
  assertObjectReadOutputWithinLimit,
  type ObjectReadExecutionLimits,
  snapshotObjectReadExecutionLimits,
} from "../execution-limits"
import { type ObjectBatchKey, objectBatchKey } from "../keys"
import { assertObjectReaderProject } from "../read-scope"
import type {
  CompiledSelectedObjectReadScope,
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
import { fullLinkRowKey, rowIdentityKeyParts, sourceLinkBucketKey } from "./keys"
import {
  buildFacetResults,
  collectLinksBatch,
  evaluateObjectQuery,
  queryLinksFrom,
  stripOuterRowShape,
} from "./query"
import {
  type InMemoryReadUniverse,
  prepareReadPlan,
  resolveSelectedReadUniverse,
} from "./read-scope"
import type { InMemoryReadSource } from "./read-source"

/** Capture a selection once, then resolve its live data and enforce budgets per operation. */
export function createInMemorySelectedReader(
  source: InMemoryReadSource,
  params: {
    scope: CompiledSelectedObjectReadScope
    limits: ObjectReadExecutionLimits
  },
  queryCapabilities: () => ObjectQueryCapabilities
): ObjectReadStorage {
  const projectId = source.projectId
  const plan = prepareReadPlan(params.scope)
  const limits = snapshotObjectReadExecutionLimits(params.limits)
  const assertProject = (actualProjectId: string) =>
    assertObjectReaderProject(projectId, actualProjectId)
  const visible = <T>(value: T): T => {
    assertObjectReadOutputWithinLimit(value, limits)
    return value
  }
  const visibleMap = <TKey, TValue>(value: Map<TKey, TValue>): Map<TKey, TValue> => {
    assertObjectReadOutputWithinLimit([...value.entries()], limits)
    return value
  }
  const selectsObjectProperties: ObjectReadStorage["selectsObjectProperties"] = async (input) => {
    assertProject(input.projectId)
    const universe = resolveSelectedReadUniverse(source, plan, limits)
    return visible(
      input.items.map((item) => {
        const key = rowIdentityKeyParts(item.objectTypeId, item.primaryId)
        if (!universe.objects.has(key)) return false
        return universe.objectProperties.get(key)?.has(item.propertyId) ?? false
      })
    )
  }

  return Object.freeze({
    queryCapabilities,
    queryObjects: async (input: QueryObjectsInput) => {
      assertProject(input.projectId)
      const universe = resolveSelectedReadUniverse(source, plan, limits)
      const result = evaluateObjectQuery(input.query, universe)
      return visible({
        objects: result.entries.map((entry) => structuredClone(entry.row)),
        hasMore: result.hasMore,
        nextPageToken: result.nextPageToken,
        ...(input.includeTotal === false ? {} : { total: result.total }),
      })
    },
    countObjects: async (input: CountObjectsInput) => {
      assertProject(input.projectId)
      const universe = resolveSelectedReadUniverse(source, plan, limits)
      return visible({
        count: evaluateObjectQuery(stripOuterRowShape(input.query), universe).total,
      })
    },
    existsObjects: async (input: ExistsObjectsInput) => {
      assertProject(input.projectId)
      const universe = resolveSelectedReadUniverse(source, plan, limits)
      return visible({
        exists: evaluateObjectQuery(stripOuterRowShape(input.query), universe).total > 0,
      })
    },
    facetObjects: async (input: FacetObjectsInput) => {
      assertProject(input.projectId)
      assertObjectReadFacetCount(input.facets.length)
      const universe = resolveSelectedReadUniverse(source, plan, limits)
      const result = evaluateObjectQuery(stripOuterRowShape(input.query), universe)
      return visible(
        structuredClone({
          facets: buildFacetResults(
            result.entries.map((entry) => entry.row),
            input.facets
          ),
        })
      )
    },
    getByPrimaryId: async (input) => {
      assertProject(input.projectId)
      const universe = resolveSelectedReadUniverse(source, plan, limits)
      const row = universe.objects.get(rowIdentityKeyParts(input.objectTypeId, input.primaryId))
      return visible(row ? structuredClone(row) : null)
    },
    selectsObjectProperties,
    listLinks: async (input) => {
      assertProject(input.projectId)
      const universe = resolveSelectedReadUniverse(source, plan, limits)
      return visible(listUniverseLinks(universe, input).map((row) => structuredClone(row)))
    },
    getByPrimaryIdBatch: async (input) => {
      assertProject(input.projectId)
      const universe = resolveSelectedReadUniverse(source, plan, limits)
      const rows = new Map<ObjectBatchKey, ObjectRow>()
      for (const item of input.items) {
        const row = universe.objects.get(rowIdentityKeyParts(item.objectTypeId, item.primaryId))
        if (row) {
          rows.set(objectBatchKey(item.objectTypeId, item.primaryId), structuredClone(row))
        }
      }
      return visibleMap(rows)
    },
    listLinksBatch: async (input) => {
      assertProject(input.projectId)
      const universe = resolveSelectedReadUniverse(source, plan, limits)
      return visibleMap(
        collectLinksBatch(
          {
            all: () => universe.links.values(),
            outgoing: (item) =>
              universe.linksBySource.get(
                sourceLinkBucketKey(projectId, item.objectTypeId, item.objectId)
              ) ?? [],
          },
          input,
          true
        )
      )
    },
    queryLinks: async (input) => {
      assertProject(input.projectId)
      const universe = resolveSelectedReadUniverse(source, plan, limits)
      return visible(
        structuredClone(await queryLinksFrom(input, (item) => listUniverseLinks(universe, item)))
      )
    },
    list: async (input) => {
      assertProject(input.projectId)
      const universe = resolveSelectedReadUniverse(source, plan, limits)
      return visible(listRows(input, [...universe.objects.values()]))
    },
  } satisfies ObjectReadStorage)
}

function listUniverseLinks(
  universe: InMemoryReadUniverse,
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
    const outgoing = universe.linksBySource.get(
      sourceLinkBucketKey(params.projectId, params.objectTypeId, params.objectId)
    )
    if (outgoing) rows.push(...outgoing.filter(matches))
  }
  if (direction === "incoming" || direction === "both") {
    for (const row of universe.links.values()) {
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
