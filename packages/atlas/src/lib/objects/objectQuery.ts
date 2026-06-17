import {
  facetObjects,
  type ListObjectTypesResponse,
  type ObjectQuery,
  type ObjectQueryFacetResult,
  type ObjectQueryIssue,
  type ObjectQueryPlanSummary,
  type ObjectQueryPredicate,
  type ObjectSummary,
  queryObjects,
  toObjectSummary,
} from "@sixb/client"
import { formatValue } from "../formatValue"
import { humanizeIdentifier } from "../labels"

export type AtlasObjectType = ListObjectTypesResponse[number]
type QueryMetadata = NonNullable<AtlasObjectType["properties"][number]["query"]>
export type QueryProperty = AtlasObjectType["properties"][number] & { query?: QueryMetadata }

export type QueryFilterOperator =
  | "eq"
  | "neq"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "contains"
  | "exists"
  | "missing"

export type QueryMatchMode = "all" | "any"

export interface QueryFilter {
  id: string
  propertyId: string
  operator: QueryFilterOperator
  value?: unknown
}

export interface QuerySort {
  propertyId: string
  direction: "asc" | "desc"
}

export interface AtlasObjectQueryPage {
  objects: ObjectSummary[]
  hasMore: boolean
  nextPageToken?: string
  total?: number
  plan: ObjectQueryPlanSummary
}

export interface QuickFilterValue {
  value: unknown
  label: string
  count?: number
}

export const operatorLabels: Record<QueryFilterOperator, string> = {
  eq: "is",
  neq: "is not",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
  contains: "contains",
  exists: "exists",
  missing: "is missing",
}

export class AtlasObjectQueryError extends Error {
  readonly issues: readonly ObjectQueryIssue[]

  constructor(message: string, issues: readonly ObjectQueryIssue[] = []) {
    super(message)
    this.name = "AtlasObjectQueryError"
    this.issues = issues
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function createFilterId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `filter-${Date.now()}-${Math.random()}`
}

export function getPropertyLabel(property: Pick<QueryProperty, "id" | "name">): string {
  return humanizeIdentifier(property.name || property.id)
}

export function isFilterableProperty(property: QueryProperty): boolean {
  return (
    property.primary === true ||
    (property.query?.searchable === true && property.query.filterable === true)
  )
}

export function isSortableProperty(property: QueryProperty): boolean {
  return property.query?.searchable === true && property.query.sortable === true
}

export function isFacetProperty(property: QueryProperty): boolean {
  return property.query?.searchable === true && property.query.facet === true
}

export function schemaType(schema: unknown): string | undefined {
  if (typeof schema === "string") return schema
  if (isRecord(schema) && typeof schema.type === "string") return schema.type
  return undefined
}

export function enumValues(schema: unknown): readonly (string | number)[] | undefined {
  if (!isRecord(schema) || schema.type !== "enum" || !Array.isArray(schema.values)) return undefined
  const values = schema.values.filter(
    (value): value is string | number => typeof value === "string" || typeof value === "number"
  )
  return values.length === schema.values.length ? values : undefined
}

export function arrayItemSchema(schema: unknown): unknown {
  return isRecord(schema) && schema.type === "array" ? schema.items : undefined
}

export function isNumberSchema(schema: unknown): boolean {
  const type = schemaType(schema)
  return type === "integer" || type === "double" || type === "decimal" || type === "number"
}

export function isBooleanSchema(schema: unknown): boolean {
  return schemaType(schema) === "boolean"
}

export function isDateSchema(schema: unknown): boolean {
  const type = schemaType(schema)
  return type === "date" || type === "timestamp"
}

function isExactSchema(schema: unknown): boolean {
  const type = schemaType(schema)
  if (type === "enum") return true
  if (typeof schema === "string") return schema !== "fileRef"
  return false
}

function isSortableSchema(schema: unknown): boolean {
  const type = schemaType(schema)
  return (
    type === "string" ||
    type === "uuid" ||
    type === "integer" ||
    type === "double" ||
    type === "decimal" ||
    type === "date" ||
    type === "timestamp" ||
    type === "enum"
  )
}

function isContainsSchema(schema: unknown): boolean {
  const type = schemaType(schema)
  return type === "string" || type === "uuid" || type === "array" || type === "map"
}

export function getOperatorsForProperty(property: QueryProperty): QueryFilterOperator[] {
  if (property.primary === true && property.query?.filterable !== true) return ["eq"]

  const operators: QueryFilterOperator[] = []
  if (isExactSchema(property.schema)) operators.push("eq", "neq")
  if (isSortableSchema(property.schema)) operators.push("lt", "lte", "gt", "gte")
  if (isContainsSchema(property.schema)) operators.push("contains")
  if (isExactSchema(property.schema)) operators.push("exists", "missing")
  return operators
}

export function operatorRequiresValue(operator: QueryFilterOperator): boolean {
  return operator !== "exists" && operator !== "missing"
}

export function parseValueForSchema(
  schema: unknown,
  rawValue: string
): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = rawValue.trim()
  if (trimmed === "null") return { ok: true, value: null }

  const values = enumValues(schema)
  if (values) {
    const selected = values.find((value) => String(value) === trimmed)
    if (selected !== undefined) return { ok: true, value: selected }
    return { ok: false, error: "Choose one of the allowed values." }
  }

  if (isBooleanSchema(schema)) {
    if (trimmed === "true") return { ok: true, value: true }
    if (trimmed === "false") return { ok: true, value: false }
    return { ok: false, error: "Use true or false." }
  }

  if (isNumberSchema(schema)) {
    const parsed = Number(trimmed)
    if (Number.isFinite(parsed)) return { ok: true, value: parsed }
    return { ok: false, error: "Use a numeric value." }
  }

  if (isRecord(schema) && schema.type === "array") {
    return parseValueForSchema(arrayItemSchema(schema), rawValue)
  }

  return { ok: true, value: rawValue }
}

function filterToPredicate(filter: QueryFilter): ObjectQueryPredicate {
  if (filter.operator === "exists" || filter.operator === "missing") {
    return {
      op: "exists",
      propertyId: filter.propertyId,
      value: filter.operator === "exists",
    }
  }

  if (filter.operator === "contains") {
    return { op: "contains", propertyId: filter.propertyId, value: filter.value }
  }

  return {
    op: filter.operator,
    propertyId: filter.propertyId,
    value: filter.value,
  }
}

export function buildObjectQuery(input: {
  objectTypeId: string
  text: string
  textSearchEnabled: boolean
  filters: readonly QueryFilter[]
  matchMode: QueryMatchMode
  sort: QuerySort | null
}): ObjectQuery {
  let query: ObjectQuery = { kind: "start", objectTypeId: input.objectTypeId }
  const text = input.text.trim()

  if (text && input.textSearchEnabled) {
    query = { kind: "text", input: query, query: text }
  }

  if (input.filters.length > 0) {
    const predicates = input.filters.map(filterToPredicate)
    const predicate: ObjectQueryPredicate =
      predicates.length === 1
        ? predicates[0]
        : { op: input.matchMode === "all" ? "and" : "or", items: predicates }
    query = { kind: "filter", input: query, predicate }
  }

  if (input.sort) {
    query = {
      kind: "sort",
      input: query,
      fields: [
        {
          kind: "property",
          propertyId: input.sort.propertyId,
          direction: input.sort.direction,
        },
      ],
    }
  }

  return query
}

export function getObjectQueryError(error: unknown): AtlasObjectQueryError {
  if (error instanceof AtlasObjectQueryError) return error
  if (isRecord(error) && typeof error.error === "string") {
    const issues = Array.isArray(error.issues) ? (error.issues as ObjectQueryIssue[]) : []
    return new AtlasObjectQueryError(error.error, issues)
  }
  if (error instanceof Error) return new AtlasObjectQueryError(error.message)
  return new AtlasObjectQueryError("Object query failed")
}

export async function executeAtlasObjectQuery(
  query: ObjectQuery,
  objectType: AtlasObjectType
): Promise<AtlasObjectQueryPage> {
  const { data, error } = await queryObjects({
    body: { query, includeTotal: true },
    responseStyle: "fields",
    throwOnError: false,
  })
  if (error || !data) throw getObjectQueryError(error)

  return {
    objects: data.objects.map((object) => toObjectSummary(object, objectType)),
    hasMore: data.hasMore,
    nextPageToken: data.nextPageToken,
    total: data.total,
    plan: data.plan,
  }
}

export async function executeAtlasObjectFacets(
  query: ObjectQuery,
  facets: readonly { propertyId: string; limit: number }[]
): Promise<ObjectQueryFacetResult[]> {
  const { data, error } = await facetObjects({
    body: { query, facets: [...facets] },
    responseStyle: "fields",
    throwOnError: false,
  })
  if (error || !data) throw getObjectQueryError(error)
  return data.facets
}

export function describeFilter(
  filter: QueryFilter,
  properties: ReadonlyMap<string, QueryProperty>
): string {
  const property = properties.get(filter.propertyId)
  const propertyLabel = property ? getPropertyLabel(property) : filter.propertyId
  const operatorLabel = operatorLabels[filter.operator]
  if (!operatorRequiresValue(filter.operator)) return `${propertyLabel} ${operatorLabel}`
  return `${propertyLabel} ${operatorLabel} ${formatValue(filter.value)}`
}

export function getQuickFilterValues(
  property: QueryProperty,
  schema: unknown,
  facetResults: readonly ObjectQueryFacetResult[]
): QuickFilterValue[] {
  const buckets = facetResults.find((facet) => facet.propertyId === property.id)?.buckets ?? []
  const countForValue = (value: unknown) =>
    buckets.find((bucket) => Object.is(bucket.value, value))?.count

  const values = enumValues(schema)
  if (values) {
    return values.map((value) => ({
      value,
      label: formatValue(value),
      count: countForValue(value),
    }))
  }

  if (isBooleanSchema(schema)) {
    return [true, false].map((value) => ({
      value,
      label: value ? "True" : "False",
      count: countForValue(value),
    }))
  }

  return buckets
    .filter(
      (bucket) =>
        bucket.value === null ||
        typeof bucket.value === "string" ||
        typeof bucket.value === "number" ||
        typeof bucket.value === "boolean"
    )
    .slice(0, 8)
    .map((bucket) => ({
      value: bucket.value,
      label: formatValue(bucket.value),
      count: bucket.count,
    }))
}

export function filterHasValue(
  filters: readonly QueryFilter[],
  propertyId: string,
  value: unknown
): boolean {
  return filters.some(
    (filter) =>
      filter.propertyId === propertyId && filter.operator === "eq" && Object.is(filter.value, value)
  )
}
