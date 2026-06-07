import type {
  StoredLinkRemovedEvent,
  StoredLinkUpsertedEvent,
  StoredObjectUpsertedEvent,
  StoredTelemetryAppendedEvent,
} from "../../events"
import type { ObjectQuery, ObjectQueryPredicate, ObjectQuerySortField } from "../../objects/query"
import type {
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
  ObjectRow,
  ObjectStorage,
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
  limits: {
    totalCount: true,
    stablePageTokens: true,
  },
}

function objectRowKey(projectId: string, objectTypeId: string): string {
  return `${projectId}:${objectTypeId}`
}

function sourceLinkBucketKey(projectId: string, sourceTypeId: string, sourceId: string): string {
  return `${projectId}:${sourceTypeId}:${sourceId}`
}

function linkRowKey(linkId: string, targetTypeId: string, targetId: string): string {
  return `${linkId}:${targetTypeId}:${targetId}`
}

function fullLinkRowKey(row: ObjectLinkRow): string {
  return `${row.sourceTypeId}:${row.sourceId}:${row.linkId}:${row.targetTypeId}:${row.targetId}`
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

const PAGE_TOKEN_PREFIX = "offset:"

export class InMemoryObjectStorage implements ObjectStorage {
  private readonly rows = new Map<string, Map<string, ObjectRow>>()
  private readonly links = new Map<string, Map<string, ObjectLinkRow>>()
  private readonly appliedEventIds = new Set<string>()

  queryCapabilities(): ObjectQueryCapabilities {
    return IN_MEMORY_OBJECT_QUERY_CAPABILITIES
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

  private evaluateObjectQuery(projectId: string, query: ObjectQuery): QueryEvaluation {
    switch (query.kind) {
      case "start":
        return this.evaluateStart(projectId, query.objectTypeId)
      case "filter": {
        const input = this.evaluateObjectQuery(projectId, query.input)
        const entries = input.entries.filter((entry) =>
          matchesPredicate(entry.row, query.predicate)
        )
        return completeEvaluation(entries)
      }
      case "text": {
        const input = this.evaluateObjectQuery(projectId, query.input)
        const scoredEntries = input.entries.flatMap((entry) => {
          const score = textScore(entry.row, query.query, query.fields, query.fieldsByObjectType)
          return score > 0 ? [{ ...entry, score: entry.score + score }] : []
        })
        return completeEvaluation(scoredEntries)
      }
      case "vector": {
        const input = this.evaluateObjectQuery(projectId, query.input)
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
        const input = this.evaluateObjectQuery(projectId, query.input)
        const entries =
          query.direction === "outgoing"
            ? this.traverseOutgoing(projectId, input.entries, query.linkId)
            : this.traverseIncoming(projectId, input.entries, query.linkId)
        return completeEvaluation(entries)
      }
      case "set":
        return this.evaluateSet(projectId, query.op, query.inputs)
      case "sort": {
        const input = this.evaluateObjectQuery(projectId, query.input)
        return {
          ...input,
          entries: sortEntries(input.entries, query.fields),
        }
      }
      case "limit": {
        const input = this.evaluateObjectQuery(projectId, query.input)
        const limit = Math.max(0, query.limit)
        return {
          entries: input.entries.slice(0, limit),
          total: input.entries.length,
          hasMore: limit < input.entries.length,
        }
      }
      case "page": {
        const input = this.evaluateObjectQuery(projectId, query.input)
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
        const input = this.evaluateObjectQuery(projectId, query.input)
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
    }
  }

  private evaluateStart(projectId: string, objectTypeId: string): QueryEvaluation {
    const bucket = this.rows.get(objectRowKey(projectId, objectTypeId))
    const entries = [...(bucket?.values() ?? [])].map((row, index) => ({
      row,
      score: 0,
      order: index,
    }))
    return completeEvaluation(entries)
  }

  private evaluateSet(
    projectId: string,
    op: "union" | "intersect" | "subtract",
    inputs: readonly ObjectQuery[]
  ): QueryEvaluation {
    const evaluations = inputs.map((input) => this.evaluateObjectQuery(projectId, input))
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
    linkId: string
  ): QueryEntry[] {
    const resultsByKey = new Map<string, QueryEntry>()

    entries.forEach((entry, index) => {
      const bucket = this.links.get(
        sourceLinkBucketKey(projectId, entry.row.objectTypeId, entry.row.primaryId)
      )
      if (!bucket) return

      for (const link of bucket.values()) {
        if (link.linkId !== linkId) continue
        const target = this.rows.get(objectRowKey(projectId, link.targetTypeId))?.get(link.targetId)
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
    linkId: string
  ): QueryEntry[] {
    const inputEntriesByTarget = new Map(entries.map((entry) => [rowIdentityKey(entry.row), entry]))
    const resultsByKey = new Map<string, QueryEntry>()

    for (const bucket of this.links.values()) {
      for (const link of bucket.values()) {
        if (link.projectId !== projectId || link.linkId !== linkId) continue
        const targetEntry = inputEntriesByTarget.get(
          rowIdentityKeyParts(link.targetTypeId, link.targetId)
        )
        if (!targetEntry) continue

        const source = this.rows.get(objectRowKey(projectId, link.sourceTypeId))?.get(link.sourceId)
        if (!source) continue
        upsertEntry(resultsByKey, {
          row: source,
          score: targetEntry.score,
          order: targetEntry.order,
        })
      }
    }

    return [...resultsByKey.values()]
  }

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
    items: readonly { objectTypeId: string; objectId: string; linkId: string }[]
  }): Promise<Map<string, ObjectLinkRow[]>> {
    const result = new Map<string, ObjectLinkRow[]>()
    for (const item of params.items) {
      const rows = await this.listLinks({
        projectId: params.projectId,
        objectTypeId: item.objectTypeId,
        objectId: item.objectId,
        linkId: item.linkId,
      })
      if (rows.length > 0) {
        result.set(`${item.objectTypeId}:${item.objectId}:${item.linkId}`, [...rows])
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
      return valuesEqual(row.properties[predicate.propertyId], predicate.value)
    case "neq":
      return !valuesEqual(row.properties[predicate.propertyId], predicate.value)
    case "lt":
      return comparePropertyValues(row.properties[predicate.propertyId], predicate.value) < 0
    case "lte":
      return comparePropertyValues(row.properties[predicate.propertyId], predicate.value) <= 0
    case "gt":
      return comparePropertyValues(row.properties[predicate.propertyId], predicate.value) > 0
    case "gte":
      return comparePropertyValues(row.properties[predicate.propertyId], predicate.value) >= 0
    case "in":
      return predicate.values.some((value) =>
        valuesEqual(row.properties[predicate.propertyId], value)
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
    return actual.some((item) => valuesEqual(item, expected))
  }

  if (isPlainObject(actual) && typeof expected === "string") {
    return Object.hasOwn(actual, expected)
  }

  return false
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left instanceof Date || right instanceof Date) {
    const leftTime = dateTime(left)
    const rightTime = dateTime(right)
    return leftTime !== null && rightTime !== null && leftTime === rightTime
  }

  return Object.is(left, right)
}

function comparePropertyValues(left: unknown, right: unknown): number {
  if (left === undefined || right === undefined || left === null || right === null) {
    return Number.NaN
  }

  if (typeof left === "number" && typeof right === "number") {
    return left - right
  }

  if (typeof left === "string" && typeof right === "string") {
    return left.localeCompare(right)
  }

  if (typeof left === "boolean" && typeof right === "boolean") {
    return Number(left) - Number(right)
  }

  if (left instanceof Date || right instanceof Date) {
    const leftTime = dateTime(left)
    const rightTime = dateTime(right)
    if (leftTime === null || rightTime === null) return Number.NaN
    return leftTime - rightTime
  }

  return Number.NaN
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

  const comparison = comparePropertyValues(leftValue, rightValue)
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

function rowIdentityKey(row: ObjectRow): string {
  return rowIdentityKeyParts(row.objectTypeId, row.primaryId)
}

function rowIdentityKeyParts(objectTypeId: string, primaryId: string): string {
  return `${objectTypeId}:${primaryId}`
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

function dateTime(value: unknown): number | null {
  if (value instanceof Date) return value.getTime()
  if (typeof value === "string" || typeof value === "number") {
    const time = new Date(value).getTime()
    return Number.isNaN(time) ? null : time
  }
  return null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
