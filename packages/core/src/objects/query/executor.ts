import type { OntologyRegistry } from "../../ontology"
import type {
  ObjectQueryCapabilities,
  ObjectRow,
  ObjectStorage,
  QueryObjectsResult,
} from "../../storage"
import { ObjectQueryExecutionError, ObjectQueryPlanningError } from "./errors"
import type { ObjectQuery, ObjectQueryPredicate, ObjectQuerySortField } from "./ir"
import { normalizeObjectQuery } from "./normalize"
import { type ObjectQueryPlan, type ObjectQueryPlanningOptions, planObjectQuery } from "./planner"
import { validateObjectQuery } from "./validate"

export interface QueryExecutorOptions
  extends Omit<ObjectQueryPlanningOptions, "capabilities" | "hasQueryObjects"> {
  ontology: OntologyRegistry
  storage: ObjectStorage
  maxLimit?: number
  maxPageSize?: number
}

export interface ExecuteObjectQueryInput {
  projectId: string
  query: ObjectQuery
}

export interface ExecuteObjectQueryResult extends QueryObjectsResult {
  plan: ObjectQueryPlan
}

type FallbackEntry = {
  row: ObjectRow
  order: number
}

type FallbackEvaluation = {
  entries: FallbackEntry[]
  total: number
  hasMore: boolean
  nextPageToken?: string
}

const DEFAULT_MAX_FALLBACK_ROWS = 1_000

// Fallback page tokens are local to the core executor. Provider page tokens are
// opaque and should only be interpreted by the provider that returned them.
const PAGE_TOKEN_PREFIX = "offset:"

export class QueryExecutor {
  constructor(private readonly options: QueryExecutorOptions) {}

  async execute(input: ExecuteObjectQueryInput): Promise<ExecuteObjectQueryResult> {
    return executeObjectQuery(input, this.options)
  }
}

export async function executeObjectQuery(
  input: ExecuteObjectQueryInput,
  options: QueryExecutorOptions
): Promise<ExecuteObjectQueryResult> {
  const normalized = normalizeObjectQuery(input.query)
  const validated = validateObjectQuery(normalized, {
    ontology: options.ontology,
    maxLimit: options.maxLimit,
    maxPageSize: options.maxPageSize,
    normalize: false,
  })
  const capabilities = options.storage.queryCapabilities()
  const hasQueryObjects = typeof options.storage.queryObjects === "function"
  const plannedQuery = expandPushdownQuery(validated.query, options.ontology, capabilities, {
    hasQueryObjects,
    allowFallback: options.allowFallback,
    maxFallbackRows: options.maxFallbackRows,
    requiresExplicitFallbackBound: options.requiresExplicitFallbackBound,
  })
  const plan = planObjectQuery(plannedQuery, {
    capabilities,
    hasQueryObjects,
    allowFallback: options.allowFallback,
    maxFallbackRows: options.maxFallbackRows,
    requiresExplicitFallbackBound: options.requiresExplicitFallbackBound,
  })

  if (plan.mode === "rejected") {
    throw new ObjectQueryPlanningError(plan.issues)
  }

  if (plan.mode === "pushdown") {
    if (!options.storage.queryObjects) {
      throw new ObjectQueryPlanningError(plan.providerIssues)
    }
    const result = await options.storage.queryObjects({
      projectId: input.projectId,
      query: plan.query,
    })
    return { ...result, plan }
  }

  // The planner admits only the small fallback subset; unsupported cases below
  // remain as defensive guards against future planner drift.
  const fallback = await executeFallbackQuery(input.projectId, validated.query, options)
  return { ...fallback, plan }
}

function expandPushdownQuery(
  query: ObjectQuery,
  ontology: OntologyRegistry,
  capabilities: ObjectQueryCapabilities,
  planning: Omit<ObjectQueryPlanningOptions, "capabilities">
): ObjectQuery {
  const expanded = expandIncludeSubtypes(query, ontology)
  if (expanded === query) return query

  const plan = planObjectQuery(expanded, { ...planning, capabilities, allowFallback: false })
  return plan.mode === "pushdown" ? expanded : query
}

function expandIncludeSubtypes(query: ObjectQuery, ontology: OntologyRegistry): ObjectQuery {
  switch (query.kind) {
    case "start": {
      if (query.includeSubtypes !== true) return query
      const objectTypeIds = [query.objectTypeId, ...ontology.getSubTypes(query.objectTypeId)]
      if (objectTypeIds.length === 1) return { kind: "start", objectTypeId: query.objectTypeId }
      return {
        kind: "set",
        op: "union",
        inputs: objectTypeIds.map((objectTypeId) => ({ kind: "start", objectTypeId })),
      }
    }
    case "filter":
    case "text":
    case "vector":
    case "traverse":
    case "sort":
    case "limit":
    case "page":
    case "project":
      return { ...query, input: expandIncludeSubtypes(query.input, ontology) }
    case "set":
      return {
        ...query,
        inputs: query.inputs.map((input) => expandIncludeSubtypes(input, ontology)),
      }
  }
}

async function executeFallbackQuery(
  projectId: string,
  query: ObjectQuery,
  options: QueryExecutorOptions
): Promise<QueryObjectsResult> {
  const maxRows = options.maxFallbackRows ?? DEFAULT_MAX_FALLBACK_ROWS
  const evaluation = await evaluateFallbackQuery(projectId, query, options, maxRows)
  return {
    objects: evaluation.entries.map((entry) => entry.row),
    hasMore: evaluation.hasMore,
    total: evaluation.total,
    nextPageToken: evaluation.nextPageToken,
  }
}

async function evaluateFallbackQuery(
  projectId: string,
  query: ObjectQuery,
  options: QueryExecutorOptions,
  maxRows: number
): Promise<FallbackEvaluation> {
  switch (query.kind) {
    case "start":
      return evaluateFallbackStart(projectId, query, options, maxRows)
    case "filter": {
      const input = await evaluateFallbackQuery(projectId, query.input, options, maxRows)
      return completeFallbackEvaluation(
        input.entries.filter((entry) => matchesPredicate(entry.row, query.predicate))
      )
    }
    case "sort": {
      const input = await evaluateFallbackQuery(projectId, query.input, options, maxRows)
      return {
        ...input,
        entries: sortEntries(input.entries, query.fields),
      }
    }
    case "limit": {
      const input = await evaluateFallbackQuery(projectId, query.input, options, maxRows)
      const limit = Math.max(0, query.limit)
      return {
        entries: input.entries.slice(0, limit),
        total: input.entries.length,
        hasMore: limit < input.entries.length,
      }
    }
    case "page": {
      const input = await evaluateFallbackQuery(projectId, query.input, options, maxRows)
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
      const input = await evaluateFallbackQuery(projectId, query.input, options, maxRows)
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
    case "text":
    case "vector":
    case "traverse":
    case "set":
      throw new ObjectQueryExecutionError(
        "fallback_node_not_supported",
        `Fallback execution does not support query node '${query.kind}'`
      )
  }
}

async function evaluateFallbackStart(
  projectId: string,
  query: Extract<ObjectQuery, { kind: "start" }>,
  options: QueryExecutorOptions,
  maxRows: number
): Promise<FallbackEvaluation> {
  const objectTypeIds = query.includeSubtypes
    ? [query.objectTypeId, ...options.ontology.getSubTypes(query.objectTypeId)]
    : [query.objectTypeId]

  const result = await options.storage.list({
    projectId,
    objectTypeId: objectTypeIds,
    limit: maxRows + 1,
    orderBy: "primaryId",
    order: "asc",
  })
  // Request one extra row so the executor can prove the source scan stayed
  // within its bound even when the storage backend does not return total counts.
  if (result.objects.length > maxRows || result.hasMore || result.total > maxRows) {
    throw new ObjectQueryExecutionError(
      "fallback_row_limit_exceeded",
      `Fallback start '${query.objectTypeId}' exceeded maxFallbackRows=${maxRows}`,
      "$.start"
    )
  }

  return completeFallbackEvaluation(
    result.objects.map((row, index) => ({
      row,
      order: index,
    }))
  )
}

function completeFallbackEvaluation(entries: FallbackEntry[]): FallbackEvaluation {
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

function sortEntries(
  entries: readonly FallbackEntry[],
  fields: readonly ObjectQuerySortField[]
): FallbackEntry[] {
  return [...entries].sort((left, right) => {
    for (const field of fields) {
      const comparison = compareSortField(left, right, field)
      if (comparison !== 0) return comparison
    }
    // Preserve storage order for true ties, then use identity as a deterministic
    // final fallback so tests and page tokens stay stable.
    return (
      left.order - right.order || rowIdentityKey(left.row).localeCompare(rowIdentityKey(right.row))
    )
  })
}

function compareSortField(
  left: FallbackEntry,
  right: FallbackEntry,
  field: ObjectQuerySortField
): number {
  if (field.kind === "relevance") return 0

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

function projectRow(row: ObjectRow, properties: readonly string[]): ObjectRow {
  const projected: Record<string, unknown> = {}
  for (const propertyId of properties) {
    if (Object.hasOwn(row.properties, propertyId)) {
      projected[propertyId] = row.properties[propertyId]
    }
  }
  return { ...row, properties: projected }
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

  if (typeof left === "number" && typeof right === "number") return left - right
  if (typeof left === "string" && typeof right === "string") return left.localeCompare(right)
  if (typeof left === "boolean" && typeof right === "boolean") return Number(left) - Number(right)

  if (left instanceof Date || right instanceof Date) {
    const leftTime = dateTime(left)
    const rightTime = dateTime(right)
    if (leftTime === null || rightTime === null) return Number.NaN
    return leftTime - rightTime
  }

  return Number.NaN
}

function dateTime(value: unknown): number | null {
  if (value instanceof Date) return value.getTime()
  if (typeof value === "string" || typeof value === "number") {
    const time = new Date(value).getTime()
    return Number.isNaN(time) ? null : time
  }
  return null
}

function rowIdentityKey(row: ObjectRow): string {
  return `${row.objectTypeId}:${row.primaryId}`
}

function encodePageOffset(offset: number): string {
  return `${PAGE_TOKEN_PREFIX}${offset}`
}

function decodePageOffset(token: string | undefined): number {
  if (!token) return 0
  if (!token.startsWith(PAGE_TOKEN_PREFIX)) {
    throw new ObjectQueryExecutionError(
      "invalid_page_token",
      "Fallback page token must use the offset token format"
    )
  }

  const offset = Number(token.slice(PAGE_TOKEN_PREFIX.length))
  if (!Number.isInteger(offset) || offset < 0) {
    throw new ObjectQueryExecutionError(
      "invalid_page_token",
      "Fallback page token contains an invalid offset"
    )
  }
  return offset
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
