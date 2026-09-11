import type { EffectiveLinkSnapshot, EffectiveObjectSnapshot } from "../../../materialization/model"
import type { ObjectReadExecutionLimits } from "../execution-limits"
import { type LinkBatchKey, type ObjectBatchKey, objectBatchKey } from "../keys"
import type {
  CompiledSelectedObjectReadScope,
  CountObjectsInput,
  CountObjectsResult,
  ExistsObjectsInput,
  ExistsObjectsResult,
  FacetObjectsInput,
  FacetObjectsResult,
  LinkDirection,
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
} from "../types"
import {
  compareStrings,
  fullLinkRowKey,
  linkRowKey,
  objectRowKey,
  objectRowProjectPrefix,
  sourceLinkBucketKey,
} from "./keys"
import {
  buildFacetResults,
  collectLinksBatch,
  evaluateObjectQuery,
  IN_MEMORY_OBJECT_QUERY_CAPABILITIES,
  queryLinksFrom,
  stripOuterRowShape,
} from "./query"
import type { InMemoryReadSource } from "./read-source"
import { createInMemorySelectedReader } from "./selected-reader"

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
    return createInMemorySelectedReader(this.readSource(params.projectId), params, () =>
      this.queryCapabilities()
    )
  }

  private readSource(projectId: string): InMemoryReadSource {
    // Keep indexed access live across writes and snapshot restores; do not capture individual buckets.
    return {
      projectId,
      objectsOfType: (objectTypeId) => [
        ...(this.rows.get(objectRowKey(projectId, objectTypeId))?.values() ?? []),
      ],
      getObject: (objectTypeId, primaryId) =>
        this.rows.get(objectRowKey(projectId, objectTypeId))?.get(primaryId),
      outgoingLinks: (objectTypeId, primaryId) =>
        this.links.get(sourceLinkBucketKey(projectId, objectTypeId, primaryId))?.values() ?? [],
      allLinks: () => allLinkRows(this.links),
    }
  }

  async queryObjects(params: QueryObjectsInput): Promise<QueryObjectsResult> {
    const result = evaluateObjectQuery(params.query, this.readSource(params.projectId))
    return {
      objects: result.entries.map((entry) => entry.row),
      hasMore: result.hasMore,
      nextPageToken: result.nextPageToken,
      ...(params.includeTotal === false ? {} : { total: result.total }),
    }
  }

  async countObjects(params: CountObjectsInput): Promise<CountObjectsResult> {
    return {
      count: evaluateObjectQuery(
        stripOuterRowShape(params.query),
        this.readSource(params.projectId)
      ).total,
    }
  }

  async existsObjects(params: ExistsObjectsInput): Promise<ExistsObjectsResult> {
    return {
      exists:
        evaluateObjectQuery(stripOuterRowShape(params.query), this.readSource(params.projectId))
          .total > 0,
    }
  }

  async facetObjects(params: FacetObjectsInput): Promise<FacetObjectsResult> {
    const result = evaluateObjectQuery(
      stripOuterRowShape(params.query),
      this.readSource(params.projectId)
    )
    return {
      facets: buildFacetResults(
        result.entries.map((entry) => entry.row),
        params.facets
      ),
    }
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

function* allLinkRows(
  buckets: ReadonlyMap<string, ReadonlyMap<string, ObjectLinkRow>>
): Iterable<ObjectLinkRow> {
  for (const bucket of buckets.values()) yield* bucket.values()
}
