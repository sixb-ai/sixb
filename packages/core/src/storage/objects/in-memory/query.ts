import type {
  ObjectQuery,
  ObjectQueryPredicate,
  ObjectQuerySortField,
} from "../../../objects/query"
import {
  compareQueryScalarValues,
  queryScalarValuesEqual,
} from "../../../objects/query/scalar-values"
import type { LinkBatchKey } from "../keys"
import {
  compareObjectLinkCursors,
  compareObjectLinks,
  linkBatchKey,
  objectLinkCursor,
} from "../keys"
import type {
  ObjectFacetRequest,
  ObjectFacetResult,
  ObjectLinkRow,
  ObjectQueryCapabilities,
  ObjectReadStorage,
  ObjectRow,
  QueryObjectLinksInput,
  QueryObjectLinksResult,
} from "../types"
import { compareStrings, fullLinkRowKey, rowIdentityKey, rowIdentityKeyParts } from "./keys"
import type { InMemoryReadSource } from "./read-source"

export const IN_MEMORY_OBJECT_QUERY_CAPABILITIES: ObjectQueryCapabilities = {
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

function assertLinkQueryLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("Object link query limit must be a positive safe integer.")
  }
}

export function evaluateObjectQuery(
  query: ObjectQuery,
  source: InMemoryReadSource
): QueryEvaluation {
  switch (query.kind) {
    case "start":
      return evaluateStart(query.objectTypeId, source)
    case "refs":
      return evaluateRefs(query.refs, source)
    case "filter": {
      const input = evaluateObjectQuery(query.input, source)
      const entries = input.entries.filter((entry) => matchesPredicate(entry.row, query.predicate))
      return completeEvaluation(entries)
    }
    case "text": {
      const input = evaluateObjectQuery(query.input, source)
      const scoredEntries = input.entries.flatMap((entry) => {
        const score = textScore(entry.row, query.query, query.fields, query.fieldsByObjectType)
        return score > 0 ? [{ ...entry, score: entry.score + score }] : []
      })
      return completeEvaluation(scoredEntries)
    }
    case "vector": {
      const input = evaluateObjectQuery(query.input, source)
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
      const input = evaluateObjectQuery(query.input, source)
      const entries =
        query.direction === "outgoing"
          ? traverseOutgoing(input.entries, query.linkId, source)
          : traverseIncoming(input.entries, query.linkId, query.sourceObjectTypeId, source)
      return completeEvaluation(entries)
    }
    case "set":
      return evaluateSet(query.op, query.inputs, source)
    case "sort": {
      const input = evaluateObjectQuery(query.input, source)
      return {
        ...input,
        entries: sortEntries(input.entries, query.fields),
      }
    }
    case "limit": {
      const input = evaluateObjectQuery(query.input, source)
      const limit = Math.max(0, query.limit)
      return {
        entries: input.entries.slice(0, limit),
        total: input.entries.length,
        hasMore: limit < input.entries.length,
      }
    }
    case "page": {
      const input = evaluateObjectQuery(query.input, source)
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
      const input = evaluateObjectQuery(query.input, source)
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

function evaluateStart(objectTypeId: string, source: InMemoryReadSource): QueryEvaluation {
  const rows = source.objectsOfType(objectTypeId)
  const entries = rows.map((row, index) => ({
    row,
    score: 0,
    order: index,
  }))
  return completeEvaluation(entries)
}

function evaluateRefs(
  refs: readonly { objectTypeId: string; primaryId: string }[],
  source: InMemoryReadSource
): QueryEvaluation {
  const seen = new Set<string>()
  const entries = refs
    .flatMap((ref) => {
      const key = JSON.stringify([ref.objectTypeId, ref.primaryId])
      if (seen.has(key)) return []
      seen.add(key)
      const row = source.getObject(ref.objectTypeId, ref.primaryId)
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

function evaluateSet(
  op: "union" | "intersect" | "subtract",
  inputs: readonly ObjectQuery[],
  source: InMemoryReadSource
): QueryEvaluation {
  const evaluations = inputs.map((input) => evaluateObjectQuery(input, source))
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

function traverseOutgoing(
  entries: readonly QueryEntry[],
  linkId: string,
  source: InMemoryReadSource
): QueryEntry[] {
  const resultsByKey = new Map<string, QueryEntry>()

  entries.forEach((entry, index) => {
    const links = [...source.outgoingLinks(entry.row.objectTypeId, entry.row.primaryId)]

    for (const link of links) {
      if (link.linkId !== linkId) continue
      const target = source.getObject(link.targetTypeId, link.targetId)
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

function traverseIncoming(
  entries: readonly QueryEntry[],
  linkId: string,
  sourceObjectTypeId: string | undefined,
  source: InMemoryReadSource
): QueryEntry[] {
  const inputEntriesByTarget = new Map(entries.map((entry) => [rowIdentityKey(entry.row), entry]))
  const resultsByKey = new Map<string, QueryEntry>()

  const links = [...source.allLinks()]
  for (const link of links) {
    if (link.projectId !== source.projectId || link.linkId !== linkId) continue
    if (sourceObjectTypeId !== undefined && link.sourceTypeId !== sourceObjectTypeId) continue
    const targetEntry = inputEntriesByTarget.get(
      rowIdentityKeyParts(link.targetTypeId, link.targetId)
    )
    if (!targetEntry) continue

    const row = source.getObject(link.sourceTypeId, link.sourceId)
    if (!row) continue
    upsertEntry(resultsByKey, {
      row,
      score: targetEntry.score,
      order: targetEntry.order,
    })
  }

  return [...resultsByKey.values()]
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

export function stripOuterRowShape(query: ObjectQuery): ObjectQuery {
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

export function buildFacetResults(
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

export async function queryLinksFrom(
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

export function collectLinksBatch(
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
