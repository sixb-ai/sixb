import type {
  ObjectExpansion,
  ObjectQuery,
  ObjectQueryPredicate,
  ObjectQuerySortField,
} from "../objects/query/ir"
import type { ObjectFacetRequest, ObjectFacetResult, ObjectRow } from "../storage/objects/types"
import type { ArtifactKind } from "./kinds"

/**
 * A version's queries: one `queries/<name>.json` file each, holding what `sixb objects query
 * --file` runs or `sixb objects facets --file` sends. Each reader runs them with their own rights,
 * so what an artifact shows is never a copy of what its author could read.
 */
export const ARTIFACT_QUERIES_DIRECTORY = "queries/"

/** The kinds that show live data. A document shows a live sheet instead, and a file is as it is. */
export const ARTIFACT_QUERY_KINDS: readonly ArtifactKind[] = ["sheet", "page", "slides", "canvas"]

/** A query read from its file: rows, or the facets of the rows. */
export type ArtifactQuery =
  | { readonly kind: "objects"; readonly query: ObjectQuery }
  | {
      readonly kind: "facets"
      readonly query: ObjectQuery
      readonly facets: readonly ObjectFacetRequest[]
    }

/** What a query read for its reader: the rows they may see, or the facets of those rows. */
export type ArtifactQueryResult = ArtifactObjectsQueryResult | ArtifactFacetsQueryResult

interface ArtifactQueryShape {
  /** The object types the query returns. */
  readonly resultObjectTypeIds: readonly string[]
  /** Every object type the query reads: where it starts, and each type it traverses or expands. */
  readonly readObjectTypeIds: readonly string[]
}

export interface ArtifactObjectsQueryResult extends ArtifactQueryShape {
  readonly kind: "objects"
  /**
   * At most `ARTIFACT_LIMITS.maxQueryRows`, as the reader reads them: a marked property they are
   * not cleared for is left out and listed in the row's `redactions`.
   */
  readonly objects: readonly ObjectRow[]
  /** Every row the query matches for the reader, those past the cap included. */
  readonly total: number
  /** Whether rows are left out because of the cap. A query's own `limit` leaves none out. */
  readonly truncated: boolean
}

export interface ArtifactFacetsQueryResult extends ArtifactQueryShape {
  readonly kind: "facets"
  /** Every row the query matches for the reader. */
  readonly total: number
  readonly facets: readonly ObjectFacetResult[]
}

/** Lowercase letters, digits and hyphens, as a canvas item's id. */
const QUERY_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/

export function isArtifactQueryName(name: string): boolean {
  return QUERY_NAME.test(name)
}

export function artifactQueryPath(name: string): string {
  return `${ARTIFACT_QUERIES_DIRECTORY}${name}.json`
}

/** The query a path names, or `undefined` when it is not one `queries/<name>.json` file. */
export function artifactQueryName(path: string): string | undefined {
  if (!path.startsWith(ARTIFACT_QUERIES_DIRECTORY) || !path.endsWith(".json")) return undefined

  const name = path.slice(ARTIFACT_QUERIES_DIRECTORY.length, -".json".length)
  return isArtifactQueryName(name) ? name : undefined
}

class QueryShapeError extends Error {
  constructor(
    readonly path: string,
    message: string
  ) {
    super(message)
  }
}

/**
 * Reads a query file into its query, and where the query sits in the file (`$`, or `$.query` in
 * a request) so a problem found later names its place in the file. A file is one of:
 *
 * - a query node, `{ "kind": "start", ... }`, for rows;
 * - `{ "query": <node> }`, for rows;
 * - `{ "query": <node>, "facets": [{ "propertyId": "status", "limit": 10 }] }`, for facets.
 *
 * Only what an author writes is read: the fields core resolves itself are refused, as the API
 * refuses them. `page`, `vector` and `rerank` are refused too, saying why.
 */
export function parseArtifactQuery(
  path: string,
  text: string
): { readonly query: ArtifactQuery; readonly at: "$" | "$.query" } | { readonly error: string } {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { error: `${path} is not valid JSON.` }
  }

  try {
    return readFile(value)
  } catch (error) {
    if (error instanceof QueryShapeError)
      return { error: `${path}: ${error.path}: ${error.message}` }
    throw error
  }
}

function readFile(value: unknown): { query: ArtifactQuery; at: "$" | "$.query" } {
  const file = record(value, "$")

  if (Object.hasOwn(file, "kind")) {
    return { query: { kind: "objects", query: readNode(file, "$") }, at: "$" }
  }

  if (!Object.hasOwn(file, "query")) {
    throw new QueryShapeError(
      "$",
      'a query file holds a query node, with "kind", or a request, with "query".'
    )
  }

  if (!Object.hasOwn(file, "facets")) {
    only(file, "$", ["query", "includeTotal"], "a query request")
    // A file written for `sixb objects query` keeps its total: a reader always gets one.
    if (file.includeTotal !== undefined) boolean(file, "includeTotal", "$")

    return { query: { kind: "objects", query: readNode(file.query, "$.query") }, at: "$.query" }
  }

  only(file, "$", ["query", "facets"], "a facets request")
  const query = readNode(file.query, "$.query")
  const facets = list(file.facets, "$.facets").map((facet, index) =>
    readFacet(facet, `$.facets[${index}]`)
  )
  if (facets.length === 0) throw new QueryShapeError("$.facets", "list at least one facet.")

  return { query: { kind: "facets", query, facets }, at: "$.query" }
}

function readFacet(value: unknown, path: string): ObjectFacetRequest {
  const facet = record(value, path)
  only(facet, path, ["propertyId", "limit"], "a facet")

  const limit = facet.limit
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) {
    throw new QueryShapeError(`${path}.limit`, "must be a positive whole number.")
  }

  return { propertyId: text(facet, "propertyId", path), limit }
}

const NODE_KEYS = {
  start: ["objectTypeId", "includeSubtypes"],
  refs: ["refs"],
  filter: ["input", "predicate"],
  text: ["input", "query", "fields"],
  traverse: ["input", "linkId", "direction", "sourceObjectTypeId"],
  set: ["op", "inputs"],
  sort: ["input", "fields"],
  limit: ["input", "limit"],
  project: ["input", "properties"],
  expand: ["input", "expansions", "users"],
} as const

/** Why each node the API runs is not one a query file may hold. */
const REFUSED_NODES: Readonly<Record<string, string>> = {
  page: 'Sixb pages the result for each reader; bound the query with "limit" instead.',
  vector: "each reader who opens the artifact would pay for an embedding call.",
  rerank: "each reader who opens the artifact would pay for a reranking call.",
}

function readNode(value: unknown, path: string): ObjectQuery {
  const node = record(value, path)
  const kind = node.kind

  if (typeof kind === "string" && Object.hasOwn(REFUSED_NODES, kind)) {
    throw new QueryShapeError(
      `${path}.kind`,
      `"${kind}" is not allowed in an artifact's query: ${REFUSED_NODES[kind]}`
    )
  }
  if (typeof kind !== "string" || !Object.hasOwn(NODE_KEYS, kind)) {
    throw new QueryShapeError(
      `${path}.kind`,
      `${JSON.stringify(kind)} is not a query node; use ${Object.keys(NODE_KEYS).join(", ")}.`
    )
  }

  const known = kind as keyof typeof NODE_KEYS
  only(node, path, ["kind", ...NODE_KEYS[known]], `a "${known}" node`)
  const input = () => readNode(node.input, `${path}.input`)

  switch (known) {
    case "start":
      return {
        kind: known,
        objectTypeId: text(node, "objectTypeId", path),
        ...(node.includeSubtypes === undefined
          ? {}
          : { includeSubtypes: boolean(node, "includeSubtypes", path) }),
      }

    case "refs":
      return {
        kind: known,
        refs: list(node.refs, `${path}.refs`).map((ref, index) => {
          const at = `${path}.refs[${index}]`
          const entry = record(ref, at)
          only(entry, at, ["objectTypeId", "primaryId"], "a ref")
          return {
            objectTypeId: text(entry, "objectTypeId", at),
            primaryId: text(entry, "primaryId", at),
          }
        }),
      }

    case "filter":
      return {
        kind: known,
        input: input(),
        predicate: readPredicate(node.predicate, `${path}.predicate`),
      }

    case "text":
      return {
        kind: known,
        input: input(),
        query: string(node, "query", path),
        ...(node.fields === undefined ? {} : { fields: texts(node.fields, `${path}.fields`) }),
      }

    case "traverse":
      return {
        kind: known,
        input: input(),
        linkId: text(node, "linkId", path),
        direction: direction(node, path),
        ...(node.sourceObjectTypeId === undefined
          ? {}
          : { sourceObjectTypeId: text(node, "sourceObjectTypeId", path) }),
      }

    case "set":
      return {
        kind: known,
        op: oneOf(node, "op", path, ["union", "intersect", "subtract"] as const),
        inputs: list(node.inputs, `${path}.inputs`).map((each, index) =>
          readNode(each, `${path}.inputs[${index}]`)
        ),
      }

    case "sort":
      return { kind: known, input: input(), fields: sortFields(node.fields, `${path}.fields`) }

    case "limit":
      return { kind: known, input: input(), limit: count(node, "limit", path) }

    case "project":
      return {
        kind: known,
        input: input(),
        ...(node.properties === undefined
          ? {}
          : { properties: texts(node.properties, `${path}.properties`) }),
      }

    case "expand":
      return {
        kind: known,
        input: input(),
        expansions: expansions(node.expansions, `${path}.expansions`),
        ...(node.users === undefined ? {} : { users: texts(node.users, `${path}.users`) }),
      }
  }
}

function readPredicate(value: unknown, path: string): ObjectQueryPredicate {
  const predicate = record(value, path)
  const op = predicate.op

  switch (op) {
    case "and":
    case "or":
      only(predicate, path, ["op", "items"], `an "${op}" predicate`)
      return {
        op,
        items: list(predicate.items, `${path}.items`).map((item, index) =>
          readPredicate(item, `${path}.items[${index}]`)
        ),
      }

    case "not":
      only(predicate, path, ["op", "item"], 'a "not" predicate')
      return { op, item: readPredicate(predicate.item, `${path}.item`) }

    case "eq":
    case "neq":
    case "lt":
    case "lte":
    case "gt":
    case "gte":
    case "contains":
      only(predicate, path, ["op", "propertyId", "value"], `an "${op}" predicate`)
      return {
        op,
        propertyId: text(predicate, "propertyId", path),
        value: present(predicate, "value", path),
      }

    case "in":
      only(predicate, path, ["op", "propertyId", "values"], 'an "in" predicate')
      return {
        op,
        propertyId: text(predicate, "propertyId", path),
        values: list(predicate.values, `${path}.values`),
      }

    case "exists":
      only(predicate, path, ["op", "propertyId", "value"], 'an "exists" predicate')
      return {
        op,
        propertyId: text(predicate, "propertyId", path),
        value: boolean(predicate, "value", path),
      }

    default:
      throw new QueryShapeError(
        `${path}.op`,
        `${JSON.stringify(op)} is not a predicate; use and, or, not, eq, neq, lt, lte, gt, gte, in, exists or contains.`
      )
  }
}

function sortFields(value: unknown, path: string): ObjectQuerySortField[] {
  return list(value, path).map((each, index) => {
    const at = `${path}[${index}]`
    const field = record(each, at)
    const kind = oneOf(field, "kind", at, ["property", "relevance"] as const)

    if (kind === "relevance") {
      only(field, at, ["kind", "direction"], "a relevance sort")
      return { kind, ...sortDirection(field, at) }
    }

    only(field, at, ["kind", "propertyId", "direction"], "a property sort")
    return { kind, propertyId: text(field, "propertyId", at), ...sortDirection(field, at) }
  })
}

function sortDirection(field: Record<string, unknown>, path: string) {
  return field.direction === undefined
    ? {}
    : { direction: oneOf(field, "direction", path, ["asc", "desc"] as const) }
}

function expansions(value: unknown, path: string): ObjectExpansion[] {
  return list(value, path).map((each, index) => {
    const at = `${path}[${index}]`
    const expansion = record(each, at)
    only(
      expansion,
      at,
      ["linkId", "direction", "sourceObjectTypeId", "limit", "orderBy", "expand", "users"],
      "an expansion"
    )

    return {
      linkId: text(expansion, "linkId", at),
      direction: direction(expansion, at),
      ...(expansion.sourceObjectTypeId === undefined
        ? {}
        : { sourceObjectTypeId: text(expansion, "sourceObjectTypeId", at) }),
      ...(expansion.limit === undefined ? {} : { limit: count(expansion, "limit", at) }),
      ...(expansion.orderBy === undefined
        ? {}
        : { orderBy: sortFields(expansion.orderBy, `${at}.orderBy`) }),
      ...(expansion.expand === undefined
        ? {}
        : { expand: expansions(expansion.expand, `${at}.expand`) }),
      ...(expansion.users === undefined ? {} : { users: texts(expansion.users, `${at}.users`) }),
    }
  })
}

function direction(value: Record<string, unknown>, path: string) {
  return oneOf(value, "direction", path, ["outgoing", "incoming"] as const)
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new QueryShapeError(path, "must be an object.")
  }
  return value as Record<string, unknown>
}

function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new QueryShapeError(path, "must be a list.")
  return value
}

/** Refuses a key the shape does not have, such as one core resolves itself. */
function only(
  value: Record<string, unknown>,
  path: string,
  keys: readonly string[],
  shape: string
): void {
  const extra = Object.keys(value).find((key) => !keys.includes(key))
  if (extra !== undefined) {
    throw new QueryShapeError(`${path}.${extra}`, `is not a key of ${shape}.`)
  }
}

function present(value: Record<string, unknown>, key: string, path: string): unknown {
  if (!Object.hasOwn(value, key)) throw new QueryShapeError(`${path}.${key}`, "is missing.")
  return value[key]
}

function string(value: Record<string, unknown>, key: string, path: string): string {
  const found = value[key]
  if (typeof found !== "string") throw new QueryShapeError(`${path}.${key}`, "must be text.")
  return found
}

/** Text that is not empty, as an id is. */
function text(value: Record<string, unknown>, key: string, path: string): string {
  const found = string(value, key, path)
  if (found.length === 0) throw new QueryShapeError(`${path}.${key}`, "must not be empty.")
  return found
}

function texts(value: unknown, path: string): string[] {
  return list(value, path).map((each, index) => {
    if (typeof each !== "string" || each.length === 0) {
      throw new QueryShapeError(`${path}[${index}]`, "must be text that is not empty.")
    }
    return each
  })
}

function boolean(value: Record<string, unknown>, key: string, path: string): boolean {
  const found = value[key]
  if (typeof found !== "boolean") {
    throw new QueryShapeError(`${path}.${key}`, "must be true or false.")
  }
  return found
}

function count(value: Record<string, unknown>, key: string, path: string): number {
  const found = value[key]
  if (typeof found !== "number" || !Number.isInteger(found) || found < 0) {
    throw new QueryShapeError(`${path}.${key}`, "must be a whole number, 0 or more.")
  }
  return found
}

function oneOf<const TValue extends string>(
  value: Record<string, unknown>,
  key: string,
  path: string,
  values: readonly TValue[]
): TValue {
  const found = value[key]
  if (typeof found !== "string" || !(values as readonly string[]).includes(found)) {
    throw new QueryShapeError(
      `${path}.${key}`,
      `${JSON.stringify(found)} is not one of ${values.join(", ")}.`
    )
  }
  return found as TValue
}
