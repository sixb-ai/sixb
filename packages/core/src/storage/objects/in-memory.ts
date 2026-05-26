import type {
  StoredLinkRemovedEvent,
  StoredLinkUpsertedEvent,
  StoredObjectUpsertedEvent,
  StoredTelemetryAppendedEvent,
} from "../../events"
import type { ObjectLinkRow, ObjectRow, ObjectStorage } from "./types"

function objectRowKey(projectId: string, objectTypeId: string): string {
  return `${projectId}:${objectTypeId}`
}

function sourceLinkBucketKey(projectId: string, sourceTypeId: string, sourceId: string): string {
  return `${projectId}:${sourceTypeId}:${sourceId}`
}

function linkRowKey(linkId: string, targetTypeId: string, targetId: string): string {
  return `${linkId}:${targetTypeId}:${targetId}`
}

export class InMemoryObjectStorage implements ObjectStorage {
  private readonly rows = new Map<string, Map<string, ObjectRow>>()
  private readonly links = new Map<string, Map<string, ObjectLinkRow>>()
  private readonly appliedEventIds = new Set<string>()

  async applyObjectUpserted(event: StoredObjectUpsertedEvent): Promise<ObjectRow> {
    const bucketId = objectRowKey(event.projectId, event.payload.objectTypeId)
    const bucket = this.rows.get(bucketId) ?? new Map<string, ObjectRow>()
    this.rows.set(bucketId, bucket)

    const existing = bucket.get(event.payload.primaryId)

    if (this.appliedEventIds.has(event.id) && existing) {
      return existing
    }

    const occurredAt = new Date(event.occurredAt)
    const next: ObjectRow = {
      projectId: event.projectId,
      objectTypeId: event.payload.objectTypeId,
      primaryId: event.payload.primaryId,
      properties: {
        ...(existing?.properties ?? {}),
        ...event.payload.properties,
      },
      createdAt: existing?.createdAt ?? occurredAt,
      updatedAt: occurredAt,
      version: (existing?.version ?? 0) + 1,
      sourceEventId: event.id,
    }

    bucket.set(event.payload.primaryId, next)
    this.appliedEventIds.add(event.id)
    return next
  }

  async applyObjectUpsertedBatch(
    events: readonly StoredObjectUpsertedEvent[]
  ): Promise<readonly ObjectRow[]> {
    const results: ObjectRow[] = []
    for (const event of events) {
      results.push(await this.applyObjectUpserted(event))
    }
    return results
  }

  async applyTelemetryAppended(event: StoredTelemetryAppendedEvent): Promise<void> {
    const bucketId = objectRowKey(event.projectId, event.payload.objectTypeId)
    const bucket = this.rows.get(bucketId)
    if (!bucket) return

    const existing = bucket.get(event.payload.objectId)
    if (!existing) return

    if (this.appliedEventIds.has(event.id)) {
      return
    }

    const next: ObjectRow = {
      ...existing,
      properties: {
        ...existing.properties,
        [event.payload.propertyId]: event.payload.value,
      },
      updatedAt: new Date(event.payload.at),
      sourceEventId: event.id,
      version: existing.version + 1,
    }

    bucket.set(event.payload.objectId, next)
    this.appliedEventIds.add(event.id)
  }

  async applyTelemetryAppendedBatch(
    events: readonly StoredTelemetryAppendedEvent[]
  ): Promise<void> {
    for (const event of events) {
      await this.applyTelemetryAppended(event)
    }
  }

  async applyLinkUpserted(event: StoredLinkUpsertedEvent): Promise<void> {
    const bucketKey = sourceLinkBucketKey(
      event.projectId,
      event.payload.sourceTypeId,
      event.payload.sourceId
    )
    const bucket = this.links.get(bucketKey) ?? new Map<string, ObjectLinkRow>()
    this.links.set(bucketKey, bucket)

    const key = linkRowKey(event.payload.linkId, event.payload.targetTypeId, event.payload.targetId)

    const existing = bucket.get(key)
    if (this.appliedEventIds.has(event.id) && existing) {
      return
    }

    const occurredAt = new Date(event.occurredAt)
    const next: ObjectLinkRow = {
      projectId: event.projectId,
      sourceTypeId: event.payload.sourceTypeId,
      sourceId: event.payload.sourceId,
      linkId: event.payload.linkId,
      targetTypeId: event.payload.targetTypeId,
      targetId: event.payload.targetId,
      properties: event.payload.properties,
      createdAt: existing?.createdAt ?? occurredAt,
      updatedAt: occurredAt,
      sourceEventId: event.id,
    }

    bucket.set(key, next)
    this.appliedEventIds.add(event.id)
  }

  async applyLinkUpsertedBatch(events: readonly StoredLinkUpsertedEvent[]): Promise<void> {
    for (const event of events) {
      await this.applyLinkUpserted(event)
    }
  }

  async applyLinkRemoved(event: StoredLinkRemovedEvent): Promise<void> {
    const bucketKey = sourceLinkBucketKey(
      event.projectId,
      event.payload.sourceTypeId,
      event.payload.sourceId
    )
    const bucket = this.links.get(bucketKey)
    if (!bucket) return

    const key = linkRowKey(event.payload.linkId, event.payload.targetTypeId, event.payload.targetId)

    if (this.appliedEventIds.has(event.id)) {
      return
    }

    bucket.delete(key)
    this.appliedEventIds.add(event.id)
  }

  async getByPrimaryId(params: {
    projectId: string
    objectTypeId: string
    primaryId: string
  }): Promise<ObjectRow | null> {
    const bucket = this.rows.get(objectRowKey(params.projectId, params.objectTypeId))
    if (!bucket) return null
    return bucket.get(params.primaryId) ?? null
  }

  async findFirst(params: {
    projectId: string
    objectTypeId: string
    where?: readonly {
      propertyId: string
      op: "eq"
      value: unknown
    }[]
  }): Promise<ObjectRow | null> {
    const bucket = this.rows.get(objectRowKey(params.projectId, params.objectTypeId))
    if (!bucket) return null

    const rows = [...bucket.values()]
    if (!params.where || params.where.length === 0) {
      return rows[0] ?? null
    }

    const row = rows.find((candidate) => {
      return params.where?.every((clause) => {
        if (clause.op === "eq") {
          return candidate.properties[clause.propertyId] === clause.value
        }
        return false
      })
    })

    return row ?? null
  }

  async listLinks(params: {
    projectId: string
    sourceTypeId: string
    sourceId: string
    linkId?: string
  }): Promise<readonly ObjectLinkRow[]> {
    const bucketKey = sourceLinkBucketKey(params.projectId, params.sourceTypeId, params.sourceId)
    const bucket = this.links.get(bucketKey)
    if (!bucket) {
      return []
    }

    const rows = [...bucket.values()]
    if (!params.linkId) {
      return rows
    }

    return rows.filter((row) => row.linkId === params.linkId)
  }

  async getByPrimaryIdBatch(params: {
    projectId: string
    items: readonly { objectTypeId: string; primaryId: string }[]
  }): Promise<Map<string, ObjectRow>> {
    const result = new Map<string, ObjectRow>()
    for (const item of params.items) {
      const row = await this.getByPrimaryId({
        projectId: params.projectId,
        objectTypeId: item.objectTypeId,
        primaryId: item.primaryId,
      })
      if (row) {
        result.set(`${item.objectTypeId}:${item.primaryId}`, row)
      }
    }
    return result
  }

  async listLinksBatch(params: {
    projectId: string
    items: readonly { sourceTypeId: string; sourceId: string; linkId: string }[]
  }): Promise<Map<string, ObjectLinkRow[]>> {
    const result = new Map<string, ObjectLinkRow[]>()
    for (const item of params.items) {
      const rows = await this.listLinks({
        projectId: params.projectId,
        sourceTypeId: item.sourceTypeId,
        sourceId: item.sourceId,
        linkId: item.linkId,
      })
      if (rows.length > 0) {
        result.set(`${item.sourceTypeId}:${item.sourceId}:${item.linkId}`, [...rows])
      }
    }
    return result
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
        if (key.startsWith(`${params.projectId}:`)) {
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
}
