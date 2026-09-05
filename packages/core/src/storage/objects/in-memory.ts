import type { EffectiveLinkSnapshot, EffectiveObjectSnapshot } from "../../materialization/model"
import type { ObjectQuery, ObjectQueryPredicate, ObjectQuerySortField } from "../../objects/query"
import { compareQueryScalarValues, queryScalarValuesEqual } from "../../objects/query/scalar-values"
import type { ObjectReadExecutionLimits } from "./execution-limits"
import {
  assertObjectReadFacetCount,
  assertObjectReadOutputWithinLimit,
  ObjectReadLimitExceededError,
  snapshotObjectReadExecutionLimits,
} from "./execution-limits"
import type { LinkBatchKey, ObjectBatchKey } from "./keys"
import {
  compareObjectLinkCursors,
  compareObjectLinks,
  linkBatchKey,
  objectBatchKey,
  objectLinkCursor,
} from "./keys"
import { assertObjectReaderProject } from "./read-scope"
import type {
  CompiledObjectReadRoot,
  CompiledObjectReadStep,
  CompiledSelectedObjectReadScope,
  CountObjectsInput,
  CountObjectsResult,
  ExistsObjectsInput,
  ExistsObjectsResult,
  FacetObjectsInput,
  FacetObjectsResult,
  LinkDirection,
  ObjectFacetRequest,
  ObjectFacetResult,
  ObjectLinkRow,
  ObjectQueryCapabilities,
  ObjectReadScopeFactory,
  ObjectReadStorage,
  ObjectRow,
  ObjectStorage,
  QueryObjectLinksInput,
  QueryObjectLinksResult,
  QueryObjectsInput,
  QueryObjectsResult,
} from "./types"

const IN_MEMORY_OBJECT_QUERY_CAPABILITIES: ObjectQueryCapabilities = {
  queryObjects: true,
  countObjects: true,
  existsObjects: true,
  facetObjects: true,
  nodes: {
    start: true,
    refs: true,
    filter: true,
    text: true,
    vector: true,
    traverse: true,
    set: true,
    sort: true,
    limit: true,
    page: true,
    project: true,
  },
  predicateOps: {
    and: true,
    or: true,
    not: true,
    eq: true,
    neq: true,
    lt: true,
    lte: true,
    gt: true,
    gte: true,
    in: true,
    exists: true,
    contains: true,
  },
  sortKinds: {
    property: true,
    relevance: true,
  },
  traversalDirections: {
    outgoing: true,
    incoming: true,
  },
  setOps: {
    union: true,
    intersect: true,
    subtract: true,
  },
  scalarOperations: {
    string: { equality: true, ordering: true },
    uuid: { equality: true, ordering: true },
    boolean: { equality: true },
    integer: { equality: true, ordering: true },
    double: { equality: true, ordering: true },
    decimal: { equality: true, ordering: true },
    date: { equality: true, ordering: true },
    timestamp: { equality: true, ordering: true },
  },
  limits: {
    totalCount: true,
    stablePageTokens: true,
  },
}

function objectRowKey(projectId: string, objectTypeId: string): string {
  return JSON.stringify([projectId, objectTypeId])
}

function objectRowProjectPrefix(projectId: string): string {
  return `[${JSON.stringify(projectId)},`
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function assertLinkQueryLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("Object link query limit must be a positive safe integer.")
  }
}

function sourceLinkBucketKey(projectId: string, sourceTypeId: string, sourceId: string): string {
  return JSON.stringify([projectId, sourceTypeId, sourceId])
}

function linkRowKey(linkId: string, targetTypeId: string, targetId: string): string {
  return JSON.stringify([linkId, targetTypeId, targetId])
}

function fullLinkRowKey(row: ObjectLinkRow): string {
  return JSON.stringify([
    row.sourceTypeId,
    row.sourceId,
    row.linkId,
    row.targetTypeId,
    row.targetId,
  ])
}

type QueryEntry = {
  row: ObjectRow
  score: number
  order: number
}

type QueryEvaluation = {
  entries: QueryEntry[]
  total: number
  hasMore: boolean
  nextPageToken?: string
}

interface InMemoryReadUniverse {
  readonly objects: ReadonlyMap<string, ObjectRow>
  readonly links: ReadonlyMap<string, ObjectLinkRow>
  readonly linksBySource: ReadonlyMap<string, readonly ObjectLinkRow[]>
  readonly objectProperties: ReadonlyMap<string, ReadonlySet<string>>
}

interface InMemoryReadPlan {
  readonly roots: readonly CompiledObjectReadRoot[]
  readonly selectionsByNode: ReadonlyMap<number, ReadonlyMap<string, ReadonlySet<string>>>
  readonly steps: readonly CompiledObjectReadStep[]
}

const PAGE_TOKEN_PREFIX = "offset:"

export interface InMemoryObjectStorageSnapshot {
  readonly rows: Map<string, Map<string, ObjectRow>>
  readonly links: Map<string, Map<string, ObjectLinkRow>>
}

interface InMemoryObjectMaterializerAdapter {
  getExactObjectRow(projectId: string, objectTypeId: string, primaryId: string): ObjectRow | null
  getExactLinkRow(
    projectId: string,
    ref: {
      readonly sourceTypeId: string
      readonly sourceId: string
      readonly linkId: string
      readonly targetTypeId: string
      readonly targetId: string
    }
  ): ObjectLinkRow | null
  applyExactObject(row: EffectiveObjectSnapshot, projectId: string): void
  deleteExactObject(projectId: string, objectTypeId: string, primaryId: string): void
  applyExactLink(row: EffectiveLinkSnapshot, projectId: string): void
  deleteExactLink(row: {
    projectId: string
    sourceTypeId: string
    sourceId: string
    linkId: string
    targetTypeId: string
    targetId: string
  }): void
  visitExactLinks(projectId: string, visit: (row: ObjectLinkRow) => void): void
  visitExactScopeLinks(
    projectId: string,
    sourceTypeId: string,
    sourceId: string,
    linkId: string,
    visit: (row: ObjectLinkRow) => void
  ): void
}

const materializerAdapters = new WeakMap<InMemoryObjectStorage, InMemoryObjectMaterializerAdapter>()

/** @internal Exact access for the in-memory ontology provider; not exported from package barrels. */
export function getInMemoryObjectMaterializerAdapter(
  storage: InMemoryObjectStorage
): InMemoryObjectMaterializerAdapter {
  const adapter = materializerAdapters.get(storage)
  if (!adapter) throw new Error("[Sixb] In-memory object materializer adapter is unavailable.")
  return adapter
}

export class InMemoryObjectStorage implements ObjectStorage, ObjectReadScopeFactory {
  private readonly rows = new Map<string, Map<string, ObjectRow>>()
  private readonly links = new Map<string, Map<string, ObjectLinkRow>>()

  constructor() {
    materializerAdapters.set(this, {
      getExactObjectRow: (projectId, objectTypeId, primaryId) =>
        this.getExactObjectRow(projectId, objectTypeId, primaryId),
      getExactLinkRow: (projectId, ref) => this.getExactLinkRow(projectId, ref),
      applyExactObject: (row, projectId) => this.applyExactObject(row, projectId),
      deleteExactObject: (projectId, objectTypeId, primaryId) =>
        this.deleteExactObject(projectId, objectTypeId, primaryId),
      applyExactLink: (row, projectId) => this.applyExactLink(row, projectId),
      deleteExactLink: (row) => this.deleteExactLink(row),
      visitExactLinks: (projectId, visit) => {
        for (const bucket of this.links.values()) {
          for (const row of bucket.values()) {
            if (row.projectId === projectId) visit(structuredClone(row))
          }
        }
      },
      visitExactScopeLinks: (projectId, sourceTypeId, sourceId, linkId, visit) => {
        const bucket = this.links.get(sourceLinkBucketKey(projectId, sourceTypeId, sourceId))
        if (!bucket) return
        for (const row of bucket.values()) {
          if (row.linkId === linkId) visit(structuredClone(row))
        }
      },
    })
  }

  snapshot(): InMemoryObjectStorageSnapshot {
    return {
      rows: cloneObjectBuckets(this.rows),
      links: cloneLinkBuckets(this.links),
    }
  }

  restore(snapshot: InMemoryObjectStorageSnapshot): void {
    this.rows.clear()
    for (const [key, bucket] of cloneObjectBuckets(snapshot.rows)) {
      this.rows.set(key, bucket)
    }

    this.links.clear()
    for (const [key, bucket] of cloneLinkBuckets(snapshot.links)) {
      this.links.set(key, bucket)
    }
  }

  private getExactObjectRow(
    projectId: string,
    objectTypeId: string,
    primaryId: string
  ): ObjectRow | null {
    const row = this.rows.get(objectRowKey(projectId, objectTypeId))?.get(primaryId)
    return row ? structuredClone(row) : null
  }

  private getExactLinkRow(
    projectId: string,
    ref: {
      readonly sourceTypeId: string
      readonly sourceId: string
      readonly linkId: string
      readonly targetTypeId: string
      readonly targetId: string
    }
  ): ObjectLinkRow | null {
    const row = this.links
      .get(sourceLinkBucketKey(projectId, ref.sourceTypeId, ref.sourceId))
      ?.get(linkRowKey(ref.linkId, ref.targetTypeId, ref.targetId))
    return row ? structuredClone(row) : null
  }

  private applyExactObject(row: EffectiveObjectSnapshot, projectId: string): void {
    const bucketId = objectRowKey(projectId, row.ref.objectTypeId)
    const bucket = this.rows.get(bucketId) ?? new Map<string, ObjectRow>()
    this.rows.set(bucketId, bucket)
    bucket.set(row.ref.primaryId, {
      projectId,
      objectTypeId: row.ref.objectTypeId,
      primaryId: row.ref.primaryId,
      properties: structuredClone(row.properties) as Record<string, unknown>,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
      version: row.version,
      lastCommitId: row.lastCommitId,
    })
  }

  private deleteExactObject(projectId: string, objectTypeId: string, primaryId: string): void {
    this.deleteObjectRow(projectId, objectTypeId, primaryId)
  }

  private applyExactLink(row: EffectiveLinkSnapshot, projectId: string): void {
    const bucketKey = sourceLinkBucketKey(
      projectId,
      row.ref.source.objectTypeId,
      row.ref.source.primaryId
    )
    const bucket = this.links.get(bucketKey) ?? new Map<string, ObjectLinkRow>()
    this.links.set(bucketKey, bucket)
    bucket.set(linkRowKey(row.ref.linkId, row.ref.target.objectTypeId, row.ref.target.primaryId), {
      projectId,
      sourceTypeId: row.ref.source.objectTypeId,
      sourceId: row.ref.source.primaryId,
      linkId: row.ref.linkId,
      targetTypeId: row.ref.target.objectTypeId,
      targetId: row.ref.target.primaryId,
      properties: row.properties
        ? (structuredClone(row.properties) as Record<string, unknown>)
        : undefined,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
      lastCommitId: row.lastCommitId,
    })
  }

  private deleteExactLink(row: {
    projectId: string
    sourceTypeId: string
    sourceId: string
    linkId: string
    targetTypeId: string
    targetId: string
  }): void {
    this.deleteLinkRow(
      row.projectId,
      row.sourceTypeId,
      row.sourceId,
      row.linkId,
      row.targetTypeId,
      row.targetId
    )
  }

  queryCapabilities(): ObjectQueryCapabilities {
    return IN_MEMORY_OBJECT_QUERY_CAPABILITIES
  }

  createSelectedReadScope(params: {
    projectId: string
    scope: CompiledSelectedObjectReadScope
    limits: ObjectReadExecutionLimits
  }): ObjectReadStorage {
    const projectId = params.projectId
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
      const universe = this.resolveReadUniverse(projectId, plan, limits)
      return visible(
        input.items.map((item) => {
          const key = rowIdentityKeyParts(item.objectTypeId, item.primaryId)
          if (!universe.objects.has(key)) return false
          return universe.objectProperties.get(key)?.has(item.propertyId) ?? false
        })
      )
    }

    return Object.freeze({
      queryCapabilities: () => this.queryCapabilities(),
      queryObjects: async (input: QueryObjectsInput) => {
        assertProject(input.projectId)
        const universe = this.resolveReadUniverse(projectId, plan, limits)
        const result = this.evaluateObjectQuery(projectId, input.query, universe)
        return visible({
          objects: result.entries.map((entry) => structuredClone(entry.row)),
          hasMore: result.hasMore,
          nextPageToken: result.nextPageToken,
          ...(input.includeTotal === false ? {} : { total: result.total }),
        })
      },
      countObjects: async (input: CountObjectsInput) => {
        assertProject(input.projectId)
        const universe = this.resolveReadUniverse(projectId, plan, limits)
        return visible({
          count: this.evaluateObjectQuery(projectId, stripOuterRowShape(input.query), universe)
            .total,
        })
      },
      existsObjects: async (input: ExistsObjectsInput) => {
        assertProject(input.projectId)
        const universe = this.resolveReadUniverse(projectId, plan, limits)
        return visible({
          exists:
            this.evaluateObjectQuery(projectId, stripOuterRowShape(input.query), universe).total >
            0,
        })
      },
      facetObjects: async (input: FacetObjectsInput) => {
        assertProject(input.projectId)
        assertObjectReadFacetCount(input.facets.length)
        const universe = this.resolveReadUniverse(projectId, plan, limits)
        const result = this.evaluateObjectQuery(
          projectId,
          stripOuterRowShape(input.query),
          universe
        )
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
        const universe = this.resolveReadUniverse(projectId, plan, limits)
        const row = universe.objects.get(rowIdentityKeyParts(input.objectTypeId, input.primaryId))
        return visible(row ? structuredClone(row) : null)
      },
      selectsObjectProperties,
      listLinks: async (input) => {
        assertProject(input.projectId)
        const universe = this.resolveReadUniverse(projectId, plan, limits)
        return visible(this.listUniverseLinks(universe, input).map((row) => structuredClone(row)))
      },
      getByPrimaryIdBatch: async (input) => {
        assertProject(input.projectId)
        const universe = this.resolveReadUniverse(projectId, plan, limits)
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
        const universe = this.resolveReadUniverse(projectId, plan, limits)
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
        const universe = this.resolveReadUniverse(projectId, plan, limits)
        return visible(
          structuredClone(
            await queryLinksFrom(input, (item) => this.listUniverseLinks(universe, item))
          )
        )
      },
      list: async (input) => {
        assertProject(input.projectId)
        const universe = this.resolveReadUniverse(projectId, plan, limits)
        return visible(listRows(input, [...universe.objects.values()]))
      },
    } satisfies ObjectReadStorage)
  }

  async queryObjects(params: QueryObjectsInput): Promise<QueryObjectsResult> {
    const result = this.evaluateObjectQuery(params.projectId, params.query)
    return {
      objects: result.entries.map((entry) => entry.row),
      hasMore: result.hasMore,
      nextPageToken: result.nextPageToken,
      ...(params.includeTotal === false ? {} : { total: result.total }),
    }
  }

  async countObjects(params: CountObjectsInput): Promise<CountObjectsResult> {
    return {
      count: this.evaluateObjectQuery(params.projectId, stripOuterRowShape(params.query)).total,
    }
  }

  async existsObjects(params: ExistsObjectsInput): Promise<ExistsObjectsResult> {
    return {
      exists:
        this.evaluateObjectQuery(params.projectId, stripOuterRowShape(params.query)).total > 0,
    }
  }

  async facetObjects(params: FacetObjectsInput): Promise<FacetObjectsResult> {
    const result = this.evaluateObjectQuery(params.projectId, stripOuterRowShape(params.query))
    return {
      facets: buildFacetResults(
        result.entries.map((entry) => entry.row),
        params.facets
      ),
    }
  }

  private evaluateObjectQuery(
    projectId: string,
    query: ObjectQuery,
    universe?: InMemoryReadUniverse
  ): QueryEvaluation {
    switch (query.kind) {
      case "start":
        return this.evaluateStart(projectId, query.objectTypeId, universe)
      case "refs":
        return this.evaluateRefs(projectId, query.refs, universe)
      case "filter": {
        const input = this.evaluateObjectQuery(projectId, query.input, universe)
        const entries = input.entries.filter((entry) =>
          matchesPredicate(entry.row, query.predicate)
        )
        return completeEvaluation(entries)
      }
      case "text": {
        const input = this.evaluateObjectQuery(projectId, query.input, universe)
        const scoredEntries = input.entries.flatMap((entry) => {
          const score = textScore(entry.row, query.query, query.fields, query.fieldsByObjectType)
          return score > 0 ? [{ ...entry, score: entry.score + score }] : []
        })
        return completeEvaluation(scoredEntries)
      }
      case "vector": {
        const input = this.evaluateObjectQuery(projectId, query.input, universe)
        const scoredEntries = input.entries.flatMap((entry) => {
          const score = vectorSimilarity(entry.row.properties[query.propertyId], query.vector)
          return score === null ? [] : [{ ...entry, score: entry.score + score }]
        })
        scoredEntries.sort(compareEntriesByRelevance)
        const limit = Math.max(0, query.k)
        return {
          entries: scoredEntries.slice(0, limit),
          total: scoredEntries.length,
          hasMore: limit < scoredEntries.length,
        }
      }
      case "traverse": {
        const input = this.evaluateObjectQuery(projectId, query.input, universe)
        const entries =
          query.direction === "outgoing"
            ? this.traverseOutgoing(projectId, input.entries, query.linkId, universe)
            : this.traverseIncoming(
                projectId,
                input.entries,
                query.linkId,
                query.sourceObjectTypeId,
                universe
              )
        return completeEvaluation(entries)
      }
      case "set":
        return this.evaluateSet(projectId, query.op, query.inputs, universe)
      case "sort": {
        const input = this.evaluateObjectQuery(projectId, query.input, universe)
        return {
          ...input,
          entries: sortEntries(input.entries, query.fields),
        }
      }
      case "limit": {
        const input = this.evaluateObjectQuery(projectId, query.input, universe)
        const limit = Math.max(0, query.limit)
        return {
          entries: input.entries.slice(0, limit),
          total: input.entries.length,
          hasMore: limit < input.entries.length,
        }
      }
      case "page": {
        const input = this.evaluateObjectQuery(projectId, query.input, universe)
        const offset = decodePageOffset(query.pageToken)
        const pageSize = Math.max(0, query.pageSize)
        const nextOffset = offset + pageSize
        const hasMore = pageSize > 0 && nextOffset < input.entries.length
        return {
          entries: input.entries.slice(offset, nextOffset),
          total: input.entries.length,
          hasMore,
          nextPageToken: hasMore ? encodePageOffset(nextOffset) : undefined,
        }
      }
      case "project": {
        const input = this.evaluateObjectQuery(projectId, query.input, universe)
        if (!query.properties) return input
        const properties = query.properties
        return {
          ...input,
          entries: input.entries.map((entry) => ({
            ...entry,
            row: projectRow(entry.row, properties),
          })),
        }
      }
      case "expand":
        // `expand` is output-shaping and is gated off by the planner in this
        // slice (and stripped before aggregates run), so the in-memory engine
        // should never receive one. Link hydration lands in a later slice.
        throw new Error("[Sixb] In-memory object storage does not support 'expand' execution yet")
    }
  }

  private evaluateStart(
    projectId: string,
    objectTypeId: string,
    universe?: InMemoryReadUniverse
  ): QueryEvaluation {
    const rows = universe
      ? [...universe.objects.values()].filter((row) => row.objectTypeId === objectTypeId)
      : [...(this.rows.get(objectRowKey(projectId, objectTypeId))?.values() ?? [])]
    const entries = rows.map((row, index) => ({
      row,
      score: 0,
      order: index,
    }))
    return completeEvaluation(entries)
  }

  private evaluateRefs(
    projectId: string,
    refs: readonly { objectTypeId: string; primaryId: string }[],
    universe?: InMemoryReadUniverse
  ): QueryEvaluation {
    const seen = new Set<string>()
    const entries = refs
      .flatMap((ref) => {
        const key = JSON.stringify([ref.objectTypeId, ref.primaryId])
        if (seen.has(key)) return []
        seen.add(key)
        const row = universe
          ? universe.objects.get(rowIdentityKeyParts(ref.objectTypeId, ref.primaryId))
          : this.rows.get(objectRowKey(projectId, ref.objectTypeId))?.get(ref.primaryId)
        return row ? [row] : []
      })
      .sort(
        (left, right) =>
          compareStrings(left.objectTypeId, right.objectTypeId) ||
          compareStrings(left.primaryId, right.primaryId)
      )
      .map((row, order) => ({ row, score: 0, order }))

    return completeEvaluation(entries)
  }

  private evaluateSet(
    projectId: string,
    op: "union" | "intersect" | "subtract",
    inputs: readonly ObjectQuery[],
    universe?: InMemoryReadUniverse
  ): QueryEvaluation {
    const evaluations = inputs.map((input) => this.evaluateObjectQuery(projectId, input, universe))
    const first = evaluations[0]
    if (!first) return completeEvaluation([])

    if (op === "union") {
      const entriesByKey = new Map<string, QueryEntry>()
      for (const evaluation of evaluations) {
        for (const entry of evaluation.entries) {
          upsertEntry(entriesByKey, entry)
        }
      }
      return completeEvaluation([...entriesByKey.values()])
    }

    if (op === "intersect") {
      const otherKeySets = evaluations
        .slice(1)
        .map((evaluation) => new Set(evaluation.entries.map((entry) => rowIdentityKey(entry.row))))
      const entries = first.entries.filter((entry) => {
        const key = rowIdentityKey(entry.row)
        return otherKeySets.every((keys) => keys.has(key))
      })
      return completeEvaluation(entries)
    }

    const subtractKeys = new Set(
      evaluations
        .slice(1)
        .flatMap((evaluation) => evaluation.entries.map((entry) => rowIdentityKey(entry.row)))
    )
    return completeEvaluation(
      first.entries.filter((entry) => !subtractKeys.has(rowIdentityKey(entry.row)))
    )
  }

  private traverseOutgoing(
    projectId: string,
    entries: readonly QueryEntry[],
    linkId: string,
    universe?: InMemoryReadUniverse
  ): QueryEntry[] {
    const resultsByKey = new Map<string, QueryEntry>()

    entries.forEach((entry, index) => {
      const links = universe
        ? (universe.linksBySource.get(
            sourceLinkBucketKey(projectId, entry.row.objectTypeId, entry.row.primaryId)
          ) ?? [])
        : [
            ...(this.links
              .get(sourceLinkBucketKey(projectId, entry.row.objectTypeId, entry.row.primaryId))
              ?.values() ?? []),
          ]

      for (const link of links) {
        if (link.linkId !== linkId) continue
        const target = universe
          ? universe.objects.get(rowIdentityKeyParts(link.targetTypeId, link.targetId))
          : this.rows.get(objectRowKey(projectId, link.targetTypeId))?.get(link.targetId)
        if (!target) continue
        upsertEntry(resultsByKey, {
          row: target,
          score: entry.score,
          order: entry.order + index / 1_000_000,
        })
      }
    })

    return [...resultsByKey.values()]
  }

  private traverseIncoming(
    projectId: string,
    entries: readonly QueryEntry[],
    linkId: string,
    sourceObjectTypeId?: string,
    universe?: InMemoryReadUniverse
  ): QueryEntry[] {
    const inputEntriesByTarget = new Map(entries.map((entry) => [rowIdentityKey(entry.row), entry]))
    const resultsByKey = new Map<string, QueryEntry>()

    const links = universe
      ? universe.links.values()
      : [...this.links.values()].flatMap((bucket) => [...bucket.values()])
    for (const link of links) {
      if (link.projectId !== projectId || link.linkId !== linkId) continue
      if (sourceObjectTypeId !== undefined && link.sourceTypeId !== sourceObjectTypeId) continue
      const targetEntry = inputEntriesByTarget.get(
        rowIdentityKeyParts(link.targetTypeId, link.targetId)
      )
      if (!targetEntry) continue

      const source = universe
        ? universe.objects.get(rowIdentityKeyParts(link.sourceTypeId, link.sourceId))
        : this.rows.get(objectRowKey(projectId, link.sourceTypeId))?.get(link.sourceId)
      if (!source) continue
      upsertEntry(resultsByKey, {
        row: source,
        score: targetEntry.score,
        order: targetEntry.order,
      })
    }

    return [...resultsByKey.values()]
  }

  private resolveReadUniverse(
    projectId: string,
    plan: InMemoryReadPlan,
    limits: ObjectReadExecutionLimits
  ): InMemoryReadUniverse {
    return this.resolveSelectedReadUniverse(projectId, plan, limits)
  }

  private resolveSelectedReadUniverse(
    projectId: string,
    plan: InMemoryReadPlan,
    limits: ObjectReadExecutionLimits
  ): InMemoryReadUniverse {
    // Reachability stays path-sensitive until every finite selection step has run. The final
    // object/link universes union exact identities only after that traversal, so the same type
    // reached through another branch cannot inherit nested link authority.
    const reachableByNode = new Map<number, Map<string, ObjectRow>>()
    const rawObjects = new Map<string, ObjectRow>()
    const objectProperties = new Map<string, Set<string>>()
    const authorizedLinks = new Map<
      string,
      { readonly row: ObjectLinkRow; readonly propertyIds: Set<string> }
    >()
    let traversalFacts = 0
    const consumeTraversalFact = (): void => {
      traversalFacts += 1
      if (traversalFacts > limits.maxTraversalFacts) {
        throw new ObjectReadLimitExceededError("traversalFacts", limits.maxTraversalFacts)
      }
    }

    const addReachable = (nodeId: number, row: ObjectRow): void => {
      const selectedProperties = plan.selectionsByNode.get(nodeId)?.get(row.objectTypeId)
      if (!selectedProperties) return
      const key = rowIdentityKey(row)
      const reachable = reachableByNode.get(nodeId) ?? new Map<string, ObjectRow>()
      reachable.set(key, row)
      reachableByNode.set(nodeId, reachable)
      rawObjects.set(key, row)
      unionInto(objectProperties, key, selectedProperties)
    }

    for (const root of plan.roots) {
      const row = this.rows.get(objectRowKey(projectId, root.objectTypeId))?.get(root.primaryId)
      if (row) {
        consumeTraversalFact()
        addReachable(root.nodeId, row)
      }
    }

    for (const step of plan.steps) {
      const parents = reachableByNode.get(step.parentNodeId)
      if (!parents) continue
      for (const parent of parents.values()) {
        if (parent.objectTypeId !== step.sourceObjectTypeId) continue
        const bucket = this.links.get(
          sourceLinkBucketKey(projectId, parent.objectTypeId, parent.primaryId)
        )
        if (!bucket) continue
        for (const link of bucket.values()) {
          if (link.linkId !== step.linkId || link.targetTypeId !== step.targetObjectTypeId) {
            continue
          }
          const target = this.rows
            .get(objectRowKey(projectId, link.targetTypeId))
            ?.get(link.targetId)
          if (!target) continue
          consumeTraversalFact()
          addReachable(step.nodeId, target)

          const linkKey = fullLinkRowKey(link)
          const selected = authorizedLinks.get(linkKey)
          if (selected) {
            for (const propertyId of step.propertyIds) selected.propertyIds.add(propertyId)
          } else {
            authorizedLinks.set(linkKey, {
              row: link,
              propertyIds: new Set(step.propertyIds),
            })
          }
        }
      }
    }

    const objects = new Map<string, ObjectRow>()
    for (const [key, propertyIds] of objectProperties) {
      const row = rawObjects.get(key)
      if (row) objects.set(key, redactObjectRow(row, propertyIds))
    }

    const links = new Map<string, ObjectLinkRow>()
    for (const [key, selected] of authorizedLinks) {
      // Both endpoint identities must remain live and selected. This also prevents a stale link
      // from exposing metadata after its target object disappears.
      if (
        !objects.has(rowIdentityKeyParts(selected.row.sourceTypeId, selected.row.sourceId)) ||
        !objects.has(rowIdentityKeyParts(selected.row.targetTypeId, selected.row.targetId))
      ) {
        continue
      }
      links.set(key, redactLinkRow(selected.row, selected.propertyIds))
    }

    return createReadUniverse(objects, links, objectProperties)
  }

  private listUniverseLinks(
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

  /**
   * Reads return the *live* stored row by reference (the SQL providers detach a copy via JSON
   * round-trip). Callers must treat read results as immutable: mutating a returned row mutates the
   * store in place — including after the transaction that read it has completed, which escapes the
   * transaction guard. Internal call sites (e.g. the EditBatch planner) already copy before
   * mutating; external callers must do the same.
   */
  async getByPrimaryId(params: {
    projectId: string
    objectTypeId: string
    primaryId: string
  }): Promise<ObjectRow | null> {
    const bucket = this.rows.get(objectRowKey(params.projectId, params.objectTypeId))
    if (!bucket) return null
    return bucket.get(params.primaryId) ?? null
  }

  async selectsObjectProperties(
    params: Parameters<ObjectReadStorage["selectsObjectProperties"]>[0]
  ): Promise<readonly boolean[]> {
    return params.items.map(
      (item) =>
        this.rows.get(objectRowKey(params.projectId, item.objectTypeId))?.has(item.primaryId) ??
        false
    )
  }

  async listLinks(params: {
    projectId: string
    objectTypeId: string
    objectId: string
    linkId?: string
    direction?: LinkDirection
  }): Promise<readonly ObjectLinkRow[]> {
    const direction = params.direction ?? "outgoing"
    const matches = (row: ObjectLinkRow) => !params.linkId || row.linkId === params.linkId
    const rows: ObjectLinkRow[] = []

    if (direction === "outgoing" || direction === "both") {
      const bucket = this.links.get(
        sourceLinkBucketKey(params.projectId, params.objectTypeId, params.objectId)
      )
      if (bucket) rows.push(...[...bucket.values()].filter(matches))
    }

    if (direction === "incoming" || direction === "both") {
      for (const bucket of this.links.values()) {
        for (const row of bucket.values()) {
          if (
            row.projectId === params.projectId &&
            row.targetTypeId === params.objectTypeId &&
            row.targetId === params.objectId &&
            matches(row)
          ) {
            rows.push(row)
          }
        }
      }
    }

    if (direction !== "both") return rows
    return [...new Map(rows.map((row) => [fullLinkRowKey(row), row])).values()]
  }

  async getByPrimaryIdBatch(params: {
    projectId: string
    items: readonly { objectTypeId: string; primaryId: string }[]
  }): Promise<Map<ObjectBatchKey, ObjectRow>> {
    const result = new Map<ObjectBatchKey, ObjectRow>()
    for (const item of params.items) {
      const row = await this.getByPrimaryId({
        projectId: params.projectId,
        objectTypeId: item.objectTypeId,
        primaryId: item.primaryId,
      })
      if (row) {
        result.set(objectBatchKey(item.objectTypeId, item.primaryId), row)
      }
    }
    return result
  }

  async listLinksBatch(params: {
    projectId: string
    direction?: LinkDirection
    items: readonly { objectTypeId: string; objectId: string; linkId: string }[]
  }): Promise<Map<LinkBatchKey, ObjectLinkRow[]>> {
    return collectLinksBatch(
      {
        all: () => allLinkRows(this.links),
        outgoing: (item) =>
          this.links
            .get(sourceLinkBucketKey(params.projectId, item.objectTypeId, item.objectId))
            ?.values() ?? [],
      },
      params,
      false
    )
  }

  async queryLinks(params: QueryObjectLinksInput): Promise<QueryObjectLinksResult> {
    return queryLinksFrom(params, (input) => this.listLinks(input))
  }

  async listIncidentLinksBatch(params: {
    projectId: string
    items: readonly { objectTypeId: string; objectId: string }[]
  }): Promise<readonly ObjectLinkRow[]> {
    const deduped = new Map<string, ObjectLinkRow>()
    for (const item of params.items) {
      const rows = await this.listLinks({
        projectId: params.projectId,
        objectTypeId: item.objectTypeId,
        objectId: item.objectId,
        direction: "both",
      })
      for (const row of rows) {
        deduped.set(fullLinkRowKey(row), row)
      }
    }
    return [...deduped.values()]
  }

  async listByPrimaryIdPage(params: {
    projectId: string
    objectTypeId: string
    afterPrimaryId?: string
    limit: number
  }): Promise<{ objects: readonly ObjectRow[]; nextPrimaryId?: string }> {
    assertReconciliationPageLimit(params.limit)
    const bucket = this.rows.get(objectRowKey(params.projectId, params.objectTypeId))
    const rows = [...(bucket?.values() ?? [])]
      .filter(
        (row) => !params.afterPrimaryId || compareStrings(row.primaryId, params.afterPrimaryId) > 0
      )
      .sort((left, right) => compareStrings(left.primaryId, right.primaryId))
      .slice(0, params.limit + 1)
    const hasMore = rows.length > params.limit
    const objects = rows.slice(0, params.limit).map((row) => structuredClone(row))
    const last = objects.at(-1)
    return {
      objects,
      ...(hasMore && last ? { nextPrimaryId: last.primaryId } : {}),
    }
  }

  async list(params: {
    projectId: string
    objectTypeId?: string | readonly string[]
    primaryIdPrefix?: string
    primaryIdSuffix?: string
    updatedAfter?: Date
    updatedBefore?: Date
    createdAfter?: Date
    createdBefore?: Date
    limit?: number
    offset?: number
    orderBy?: "createdAt" | "updatedAt" | "primaryId"
    order?: "asc" | "desc"
  }): Promise<{ objects: readonly ObjectRow[]; hasMore: boolean; total: number }> {
    let allRows: ObjectRow[] = []

    if (params.objectTypeId) {
      const typeIds = Array.isArray(params.objectTypeId)
        ? params.objectTypeId
        : [params.objectTypeId]
      for (const typeId of typeIds) {
        const bucket = this.rows.get(objectRowKey(params.projectId, typeId))
        if (bucket) {
          allRows.push(...bucket.values())
        }
      }
    } else {
      for (const [key, bucket] of this.rows) {
        if (key.startsWith(objectRowProjectPrefix(params.projectId))) {
          allRows.push(...bucket.values())
        }
      }
    }

    const {
      primaryIdPrefix,
      primaryIdSuffix,
      updatedAfter,
      updatedBefore,
      createdAfter,
      createdBefore,
    } = params
    if (
      primaryIdPrefix ||
      primaryIdSuffix ||
      updatedAfter ||
      updatedBefore ||
      createdAfter ||
      createdBefore
    ) {
      allRows = allRows.filter(
        (row) =>
          (!primaryIdPrefix || row.primaryId.startsWith(primaryIdPrefix)) &&
          (!primaryIdSuffix || row.primaryId.endsWith(primaryIdSuffix)) &&
          (!updatedAfter || row.updatedAt >= updatedAfter) &&
          (!updatedBefore || row.updatedAt <= updatedBefore) &&
          (!createdAfter || row.createdAt >= createdAfter) &&
          (!createdBefore || row.createdAt <= createdBefore)
      )
    }

    const total = allRows.length

    const offset = params.offset ?? 0
    const limit = params.limit ?? 50
    if (limit === 0) return { objects: [], hasMore: offset < total, total }

    const orderBy = params.orderBy ?? "updatedAt"
    const order = params.order ?? "desc"

    allRows.sort((a, b) => {
      let comparison = 0
      switch (orderBy) {
        case "primaryId":
          comparison = a.primaryId.localeCompare(b.primaryId)
          break
        case "createdAt":
          comparison = a.createdAt.getTime() - b.createdAt.getTime()
          break
        default:
          comparison = a.updatedAt.getTime() - b.updatedAt.getTime()
          break
      }
      return order === "desc" ? -comparison : comparison
    })

    const objects = allRows.slice(offset, offset + limit)
    const hasMore = offset + limit < total

    return { objects, hasMore, total }
  }

  private deleteObjectRow(projectId: string, objectTypeId: string, primaryId: string): void {
    const bucket = this.rows.get(objectRowKey(projectId, objectTypeId))
    bucket?.delete(primaryId)
  }

  private deleteLinkRow(
    projectId: string,
    sourceTypeId: string,
    sourceId: string,
    linkId: string,
    targetTypeId: string,
    targetId: string
  ): void {
    const bucket = this.links.get(sourceLinkBucketKey(projectId, sourceTypeId, sourceId))
    bucket?.delete(linkRowKey(linkId, targetTypeId, targetId))
  }
}

function prepareReadPlan(scope: CompiledSelectedObjectReadScope): InMemoryReadPlan {
  const selectionsByNode = new Map<number, Map<string, ReadonlySet<string>>>()
  for (const selection of scope.objects) {
    const byType = selectionsByNode.get(selection.nodeId) ?? new Map()
    byType.set(selection.objectTypeId, new Set(selection.propertyIds))
    selectionsByNode.set(selection.nodeId, byType)
  }

  // The compiler allocates node ids parent-first. Resolve every step from lower parent ids to
  // higher child ids so a node reached through several concrete definitions is complete before
  // its nested selections run.
  const steps = [...scope.steps].sort(
    (left, right) =>
      left.parentNodeId - right.parentNodeId ||
      left.nodeId - right.nodeId ||
      left.sourceObjectTypeId.localeCompare(right.sourceObjectTypeId) ||
      left.linkId.localeCompare(right.linkId) ||
      left.targetObjectTypeId.localeCompare(right.targetObjectTypeId)
  )
  return {
    roots: scope.roots,
    selectionsByNode,
    steps,
  }
}

function createReadUniverse(
  objects: ReadonlyMap<string, ObjectRow>,
  links: ReadonlyMap<string, ObjectLinkRow>,
  objectProperties: ReadonlyMap<string, ReadonlySet<string>>
): InMemoryReadUniverse {
  const linksBySource = new Map<string, ObjectLinkRow[]>()
  for (const link of links.values()) {
    const key = sourceLinkBucketKey(link.projectId, link.sourceTypeId, link.sourceId)
    const bucket = linksBySource.get(key) ?? []
    bucket.push(link)
    linksBySource.set(key, bucket)
  }
  return { objects, links, linksBySource, objectProperties }
}

function unionInto(
  target: Map<string, Set<string>>,
  key: string,
  values: ReadonlySet<string>
): void {
  const union = target.get(key) ?? new Set<string>()
  for (const value of values) union.add(value)
  target.set(key, union)
}

function redactObjectRow(row: ObjectRow, propertyIds: ReadonlySet<string>): ObjectRow {
  const clone = structuredClone(row)
  delete clone.links
  clone.properties = redactProperties(clone.properties, propertyIds)
  return clone
}

function redactLinkRow(row: ObjectLinkRow, propertyIds: ReadonlySet<string>): ObjectLinkRow {
  const clone = structuredClone(row)
  const properties = redactProperties(clone.properties ?? {}, propertyIds)
  if (Object.keys(properties).length === 0) {
    delete clone.properties
  } else {
    clone.properties = properties
  }
  return clone
}

function redactProperties(
  properties: Readonly<Record<string, unknown>>,
  propertyIds: ReadonlySet<string>
): Record<string, unknown> {
  // Object.fromEntries uses CreateDataProperty, so valid ontology ids such as `__proto__` remain
  // ordinary own properties without changing the returned object's prototype.
  return Object.fromEntries(
    [...propertyIds]
      .filter((propertyId) => Object.hasOwn(properties, propertyId))
      .map((propertyId) => [propertyId, properties[propertyId]])
  )
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

function assertReconciliationPageLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("Object reconciliation page limit must be a positive safe integer.")
  }
}

function cloneObjectBuckets(
  rows: Map<string, Map<string, ObjectRow>>
): Map<string, Map<string, ObjectRow>> {
  const clone = new Map<string, Map<string, ObjectRow>>()
  for (const [key, bucket] of rows) {
    clone.set(
      key,
      new Map([...bucket.entries()].map(([primaryId, row]) => [primaryId, structuredClone(row)]))
    )
  }
  return clone
}

function cloneLinkBuckets(
  links: Map<string, Map<string, ObjectLinkRow>>
): Map<string, Map<string, ObjectLinkRow>> {
  const clone = new Map<string, Map<string, ObjectLinkRow>>()
  for (const [key, bucket] of links) {
    clone.set(
      key,
      new Map([...bucket.entries()].map(([linkId, row]) => [linkId, structuredClone(row)]))
    )
  }
  return clone
}

function completeEvaluation(entries: QueryEntry[]): QueryEvaluation {
  return {
    entries,
    total: entries.length,
    hasMore: false,
  }
}

function matchesPredicate(row: ObjectRow, predicate: ObjectQueryPredicate): boolean {
  switch (predicate.op) {
    case "and":
      return predicate.items.every((item) => matchesPredicate(row, item))
    case "or":
      return predicate.items.some((item) => matchesPredicate(row, item))
    case "not":
      return !matchesPredicate(row, predicate.item)
    case "eq":
      return queryScalarValuesEqual(
        row.properties[predicate.propertyId],
        predicate.value,
        predicate.scalarKind
      )
    case "neq":
      return !queryScalarValuesEqual(
        row.properties[predicate.propertyId],
        predicate.value,
        predicate.scalarKind
      )
    case "lt":
      return (
        compareQueryScalarValues(
          row.properties[predicate.propertyId],
          predicate.value,
          predicate.scalarKind
        ) < 0
      )
    case "lte":
      return (
        compareQueryScalarValues(
          row.properties[predicate.propertyId],
          predicate.value,
          predicate.scalarKind
        ) <= 0
      )
    case "gt":
      return (
        compareQueryScalarValues(
          row.properties[predicate.propertyId],
          predicate.value,
          predicate.scalarKind
        ) > 0
      )
    case "gte":
      return (
        compareQueryScalarValues(
          row.properties[predicate.propertyId],
          predicate.value,
          predicate.scalarKind
        ) >= 0
      )
    case "in":
      return predicate.values.some((value) =>
        queryScalarValuesEqual(row.properties[predicate.propertyId], value, predicate.scalarKind)
      )
    case "exists": {
      const exists =
        Object.hasOwn(row.properties, predicate.propertyId) &&
        row.properties[predicate.propertyId] !== undefined
      return predicate.value ? exists : !exists
    }
    case "contains":
      return containsValue(row.properties[predicate.propertyId], predicate.value)
  }
}

function containsValue(actual: unknown, expected: unknown): boolean {
  if (typeof actual === "string" && typeof expected === "string") {
    return actual.includes(expected)
  }

  if (Array.isArray(actual)) {
    return actual.some((item) => queryScalarValuesEqual(item, expected))
  }

  if (isPlainObject(actual) && typeof expected === "string") {
    return Object.hasOwn(actual, expected)
  }

  return false
}

function textScore(
  row: ObjectRow,
  query: string,
  fields: readonly string[] | undefined,
  fieldsByObjectType: Readonly<Record<string, readonly string[]>> | undefined
): number {
  const terms = tokenize(query)
  if (terms.length === 0) return 0

  const scopedFields = fields ?? fieldsByObjectType?.[row.objectTypeId]
  const values = fields
    ? fields.flatMap((field) => collectTextValues(row.properties[field]))
    : scopedFields
      ? scopedFields.flatMap((field) => collectTextValues(row.properties[field]))
      : [row.primaryId, ...Object.values(row.properties).flatMap(collectTextValues)]
  const haystack = values.join(" ").toLowerCase()
  if (!terms.every((term) => haystack.includes(term))) return 0

  const phrase = query.trim().toLowerCase()
  const phraseBoost = phrase.length > 0 && haystack.includes(phrase) ? terms.length : 0
  return terms.reduce((score, term) => score + countOccurrences(haystack, term), phraseBoost)
}

function tokenize(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0)
}

function collectTextValues(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(collectTextValues)
  return []
}

function countOccurrences(value: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let index = value.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = value.indexOf(needle, index + needle.length)
  }
  return count
}

function vectorSimilarity(actual: unknown, expected: readonly number[]): number | null {
  if (!Array.isArray(actual) || actual.length !== expected.length || actual.length === 0) {
    return null
  }

  let dot = 0
  let actualNorm = 0
  let expectedNorm = 0
  for (let index = 0; index < expected.length; index += 1) {
    const actualValue = actual[index]
    const expectedValue = expected[index]
    if (
      typeof actualValue !== "number" ||
      typeof expectedValue !== "number" ||
      !Number.isFinite(actualValue) ||
      !Number.isFinite(expectedValue)
    ) {
      return null
    }

    dot += actualValue * expectedValue
    actualNorm += actualValue * actualValue
    expectedNorm += expectedValue * expectedValue
  }

  if (actualNorm === 0 || expectedNorm === 0) return null
  return dot / (Math.sqrt(actualNorm) * Math.sqrt(expectedNorm))
}

function sortEntries(
  entries: readonly QueryEntry[],
  fields: readonly ObjectQuerySortField[]
): QueryEntry[] {
  return [...entries].sort((left, right) => {
    for (const field of fields) {
      const comparison = compareSortField(left, right, field)
      if (comparison !== 0) return comparison
    }
    return (
      left.order - right.order || rowIdentityKey(left.row).localeCompare(rowIdentityKey(right.row))
    )
  })
}

function compareSortField(
  left: QueryEntry,
  right: QueryEntry,
  field: ObjectQuerySortField
): number {
  if (field.kind === "relevance") {
    const direction = field.direction ?? "desc"
    const comparison = right.score - left.score
    return direction === "desc" ? comparison : -comparison
  }

  const leftValue = left.row.properties[field.propertyId]
  const rightValue = right.row.properties[field.propertyId]
  const leftMissing = leftValue === undefined || leftValue === null
  const rightMissing = rightValue === undefined || rightValue === null
  if (leftMissing && rightMissing) return 0
  if (leftMissing) return 1
  if (rightMissing) return -1

  const comparison = compareQueryScalarValues(leftValue, rightValue, field.scalarKind)
  if (Number.isNaN(comparison)) return 0
  return field.direction === "desc" ? -comparison : comparison
}

function compareEntriesByRelevance(left: QueryEntry, right: QueryEntry): number {
  return (
    right.score - left.score || rowIdentityKey(left.row).localeCompare(rowIdentityKey(right.row))
  )
}

function projectRow(row: ObjectRow, properties: readonly string[]): ObjectRow {
  const projected: Record<string, unknown> = {}
  for (const propertyId of properties) {
    if (Object.hasOwn(row.properties, propertyId)) {
      projected[propertyId] = row.properties[propertyId]
    }
  }
  return {
    ...row,
    properties: projected,
  }
}

function stripOuterRowShape(query: ObjectQuery): ObjectQuery {
  switch (query.kind) {
    case "limit":
    case "page":
    case "project":
    case "sort":
    // `expand` is output-shaping: aggregates ignore it (it never changes which
    // objects match).
    case "expand":
      return stripOuterRowShape(query.input)
    default:
      return query
  }
}

function buildFacetResults(
  rows: readonly ObjectRow[],
  facets: readonly ObjectFacetRequest[]
): ObjectFacetResult[] {
  return facets.map((facet) => ({
    propertyId: facet.propertyId,
    buckets: buildFacetBuckets(rows, facet),
  }))
}

function buildFacetBuckets(
  rows: readonly ObjectRow[],
  facet: ObjectFacetRequest
): ObjectFacetResult["buckets"] {
  const buckets = new Map<string, { value: unknown; count: number }>()

  for (const row of rows) {
    if (!Object.hasOwn(row.properties, facet.propertyId)) continue
    const value = row.properties[facet.propertyId]
    if (value === undefined) continue
    const key = facetValueKey(value)
    const existing = buckets.get(key)
    if (existing) {
      existing.count += 1
    } else {
      buckets.set(key, { value, count: 1 })
    }
  }

  return [...buckets.values()]
    .sort(
      (left, right) =>
        right.count - left.count ||
        facetValueSortKey(left.value).localeCompare(facetValueSortKey(right.value))
    )
    .slice(0, facet.limit)
}

function facetValueKey(value: unknown): string {
  return JSON.stringify(value) ?? String(value)
}

function facetValueSortKey(value: unknown): string {
  return JSON.stringify(value) ?? String(value)
}

async function queryLinksFrom(
  params: QueryObjectLinksInput,
  listLinks: (
    input: Parameters<ObjectReadStorage["listLinks"]>[0]
  ) => Promise<readonly ObjectLinkRow[]> | readonly ObjectLinkRow[]
): Promise<QueryObjectLinksResult> {
  assertLinkQueryLimit(params.limit)
  if (params.objectRefs.length === 0 || params.endpointObjectTypeIds?.length === 0) {
    return { links: [], hasMore: false }
  }

  const allowedTypes = params.endpointObjectTypeIds
    ? new Set(params.endpointObjectTypeIds)
    : undefined
  const deduped = new Map<string, ObjectLinkRow>()
  for (const object of params.objectRefs) {
    const rows = await listLinks({
      projectId: params.projectId,
      objectTypeId: object.objectTypeId,
      objectId: object.primaryId,
      direction: params.direction,
      ...(params.linkId === undefined ? {} : { linkId: params.linkId }),
    })
    for (const row of rows) {
      if (
        allowedTypes &&
        (!allowedTypes.has(row.sourceTypeId) || !allowedTypes.has(row.targetTypeId))
      ) {
        continue
      }
      if (params.after && compareObjectLinkCursors(objectLinkCursor(row), params.after) <= 0) {
        continue
      }
      deduped.set(fullLinkRowKey(row), row)
    }
  }

  const rows = [...deduped.values()].sort(compareObjectLinks).slice(0, params.limit + 1)
  return { links: rows.slice(0, params.limit), hasMore: rows.length > params.limit }
}

interface LinkBatchSource {
  all(): Iterable<ObjectLinkRow>
  outgoing(item: {
    readonly objectTypeId: string
    readonly objectId: string
    readonly linkId: string
  }): Iterable<ObjectLinkRow>
}

function collectLinksBatch(
  source: LinkBatchSource,
  params: Parameters<ObjectReadStorage["listLinksBatch"]>[0],
  cloneRows: boolean
): Map<LinkBatchKey, ObjectLinkRow[]> {
  const direction = params.direction ?? "outgoing"
  const orderedKeys = [
    ...new Set(
      params.items.map((item) => linkBatchKey(item.objectTypeId, item.objectId, item.linkId))
    ),
  ]
  const requestedKeys = new Set(orderedKeys)
  const grouped = new Map<LinkBatchKey, Map<string, ObjectLinkRow>>()
  const append = (key: LinkBatchKey, row: ObjectLinkRow): void => {
    const bucket = grouped.get(key) ?? new Map<string, ObjectLinkRow>()
    bucket.set(fullLinkRowKey(row), row)
    grouped.set(key, bucket)
  }

  if (direction === "outgoing" || direction === "both") {
    for (const item of params.items) {
      const key = linkBatchKey(item.objectTypeId, item.objectId, item.linkId)
      for (const row of source.outgoing(item)) {
        if (row.projectId === params.projectId && row.linkId === item.linkId) append(key, row)
      }
    }
  }

  if (direction === "incoming" || direction === "both") {
    for (const row of source.all()) {
      if (row.projectId !== params.projectId) continue
      const key = linkBatchKey(row.targetTypeId, row.targetId, row.linkId)
      if (requestedKeys.has(key)) append(key, row)
    }
  }

  return new Map(
    orderedKeys.flatMap((key) => {
      const bucket = grouped.get(key)
      if (!bucket) return []
      return [
        [key, [...bucket.values()].map((row) => (cloneRows ? structuredClone(row) : row))] as const,
      ]
    })
  )
}

function* allLinkRows(
  buckets: ReadonlyMap<string, ReadonlyMap<string, ObjectLinkRow>>
): Iterable<ObjectLinkRow> {
  for (const bucket of buckets.values()) yield* bucket.values()
}

function rowIdentityKey(row: ObjectRow): string {
  return rowIdentityKeyParts(row.objectTypeId, row.primaryId)
}

function rowIdentityKeyParts(objectTypeId: string, primaryId: string): string {
  return objectBatchKey(objectTypeId, primaryId)
}

function upsertEntry(entriesByKey: Map<string, QueryEntry>, entry: QueryEntry): void {
  const key = rowIdentityKey(entry.row)
  const existing = entriesByKey.get(key)
  if (!existing) {
    entriesByKey.set(key, entry)
    return
  }

  if (entry.score > existing.score) {
    entriesByKey.set(key, {
      ...existing,
      score: entry.score,
    })
  }
}

function encodePageOffset(offset: number): string {
  return `${PAGE_TOKEN_PREFIX}${offset}`
}

function decodePageOffset(token: string | undefined): number {
  if (!token) return 0
  if (!token.startsWith(PAGE_TOKEN_PREFIX)) {
    throw new Error("[Sixb] Invalid object query page token")
  }

  const offset = Number(token.slice(PAGE_TOKEN_PREFIX.length))
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error("[Sixb] Invalid object query page token")
  }
  return offset
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
