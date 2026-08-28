import type { OntologyRegistry } from "../../ontology"
import type {
  ObjectExpansion,
  ObjectQuery,
  ObjectQueryPredicate,
  ObjectQueryResultShape,
  ObjectQuerySortField,
} from "./ir"
import { normalizeObjectQuery } from "./normalize"
import {
  collectObjectQueryValidationIssues,
  type ObjectQueryValidationIssue,
  validateObjectQuery,
} from "./validate"

export interface ObjectQueryExplainOptions {
  ontology?: OntologyRegistry
  normalize?: boolean
  maxLimit?: number
  maxPageSize?: number
}

export interface ObjectQueryExplanation {
  query: ObjectQuery
  normalizedQuery: ObjectQuery
  valid?: boolean
  result?: ObjectQueryResultShape
  issues: readonly ObjectQueryValidationIssue[]
  tree: ObjectQueryExplainNode
}

export interface ObjectQueryExplainNode {
  path: string
  kind: ObjectQuery["kind"]
  summary: string
  details: Record<string, unknown>
  children: readonly ObjectQueryExplainNode[]
}

export function explainObjectQuery(
  query: ObjectQuery,
  options: ObjectQueryExplainOptions = {}
): ObjectQueryExplanation {
  const normalizedQuery = options.normalize === false ? query : normalizeObjectQuery(query)
  const issues = options.ontology
    ? collectObjectQueryValidationIssues(normalizedQuery, {
        ontology: options.ontology,
        maxLimit: options.maxLimit,
        maxPageSize: options.maxPageSize,
        normalize: false,
      })
    : []

  const result =
    options.ontology && issues.length === 0
      ? validateObjectQuery(normalizedQuery, {
          ontology: options.ontology,
          maxLimit: options.maxLimit,
          maxPageSize: options.maxPageSize,
          normalize: false,
        }).result
      : undefined

  return {
    query,
    normalizedQuery,
    valid: options.ontology ? issues.length === 0 : undefined,
    result,
    issues,
    tree: buildExplainNode(normalizedQuery, "$"),
  }
}

function buildExplainNode(query: ObjectQuery, path: string): ObjectQueryExplainNode {
  switch (query.kind) {
    case "start":
      return {
        path,
        kind: query.kind,
        summary: `start ${query.objectTypeId}`,
        details: {
          objectTypeId: query.objectTypeId,
          includeSubtypes: query.includeSubtypes === true,
        },
        children: [],
      }
    case "refs":
      return {
        path,
        kind: query.kind,
        summary: `refs ${query.refs.length}`,
        details: { refs: query.refs },
        children: [],
      }
    case "filter":
      return {
        path,
        kind: query.kind,
        summary: `filter ${summarizePredicate(query.predicate)}`,
        details: { predicate: query.predicate },
        children: [buildExplainNode(query.input, `${path}.input`)],
      }
    case "text":
      return {
        path,
        kind: query.kind,
        summary: `text "${query.query}"`,
        details: {
          query: query.query,
          fields: query.fields,
          fieldsByObjectType: query.fieldsByObjectType,
        },
        children: [buildExplainNode(query.input, `${path}.input`)],
      }
    case "vector":
      return {
        path,
        kind: query.kind,
        summary: `vector ${query.propertyId} k=${query.k}`,
        details: { propertyId: query.propertyId, dimensions: query.vector.length, k: query.k },
        children: [buildExplainNode(query.input, `${path}.input`)],
      }
    case "traverse":
      return {
        path,
        kind: query.kind,
        summary:
          query.sourceObjectTypeId === undefined
            ? `traverse ${query.direction} ${query.linkId}`
            : `traverse ${query.direction} ${query.sourceObjectTypeId}.${query.linkId}`,
        details: {
          linkId: query.linkId,
          direction: query.direction,
          ...(query.sourceObjectTypeId === undefined
            ? {}
            : { sourceObjectTypeId: query.sourceObjectTypeId }),
        },
        children: [buildExplainNode(query.input, `${path}.input`)],
      }
    case "set":
      return {
        path,
        kind: query.kind,
        summary: `set ${query.op}`,
        details: { op: query.op, inputCount: query.inputs.length },
        children: query.inputs.map((input, index) =>
          buildExplainNode(input, `${path}.inputs[${index}]`)
        ),
      }
    case "sort":
      return {
        path,
        kind: query.kind,
        summary: `sort ${query.fields.map(summarizeSortField).join(", ")}`,
        details: { fields: query.fields },
        children: [buildExplainNode(query.input, `${path}.input`)],
      }
    case "limit":
      return {
        path,
        kind: query.kind,
        summary: `limit ${query.limit}`,
        details: { limit: query.limit },
        children: [buildExplainNode(query.input, `${path}.input`)],
      }
    case "page":
      return {
        path,
        kind: query.kind,
        summary: `page ${query.pageSize}`,
        details: { pageSize: query.pageSize, hasPageToken: query.pageToken !== undefined },
        children: [buildExplainNode(query.input, `${path}.input`)],
      }
    case "project":
      return {
        path,
        kind: query.kind,
        summary: `project ${query.properties?.join(", ") ?? "*"}`,
        details: { properties: query.properties },
        children: [buildExplainNode(query.input, `${path}.input`)],
      }
    case "expand":
      return {
        path,
        kind: query.kind,
        summary: `expand ${query.expansions.map(summarizeExpansion).join(", ")}`,
        details: { expansions: query.expansions },
        children: [buildExplainNode(query.input, `${path}.input`)],
      }
  }
}

function summarizeExpansion(expansion: ObjectExpansion): string {
  const head = expansion.direction === "incoming" ? `<-${expansion.linkId}` : expansion.linkId
  const nested =
    expansion.expand && expansion.expand.length > 0
      ? `(${expansion.expand.map(summarizeExpansion).join(", ")})`
      : ""
  return `${head}${nested}`
}

function summarizePredicate(predicate: ObjectQueryPredicate): string {
  switch (predicate.op) {
    case "and":
    case "or":
      return `${predicate.op}(${predicate.items.map(summarizePredicate).join(", ")})`
    case "not":
      return `not(${summarizePredicate(predicate.item)})`
    case "in":
      return `${predicate.propertyId} in [${predicate.values.length}]`
    case "exists":
      return `${predicate.propertyId} exists=${predicate.value}`
    case "contains":
      return `${predicate.propertyId} contains`
    default:
      return `${predicate.propertyId} ${predicate.op}`
  }
}

function summarizeSortField(field: ObjectQuerySortField): string {
  if (field.kind === "relevance") return `relevance ${field.direction ?? "desc"}`
  return `${field.propertyId} ${field.direction ?? "asc"}`
}
