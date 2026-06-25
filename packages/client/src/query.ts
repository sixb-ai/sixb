/**
 * Typed object queries over HTTP (`@sixb/client/query`).
 *
 * `objects(Type)` returns the same fluent query builder the server runtime
 * uses, wired to the object query routes through the generated SDK. Queries
 * are validated server-side; failures surface as `SixbQueryError`.
 */

import type { SixbObjectTypeMap } from "@sixb/core/ontology"
import type {
  ObjectQuery,
  ObjectQueryBuilder,
  ObjectQueryExecutor,
  ObjectQueryExecutorExpandedRow,
  ObjectQueryExecutorFacetRequest,
  ObjectQueryExecutorLinkValue,
  ObjectQueryExecutorRow,
  ObjectTypeWithPropertyTokens,
} from "@sixb/core/query"
import { createObjectQueryBuilder } from "@sixb/core/query"
import type { Client } from "./generated/client"
import { countObjects, existsObjects, facetObjects, queryObjects } from "./generated/sdk.gen"
import type {
  ObjectQueryIssue,
  ObjectQueryObject,
  ObjectQuery as WireObjectQuery,
} from "./generated/types.gen"

export type { ObjectQueryIssue }

export class SixbQueryError extends Error {
  readonly issues: readonly ObjectQueryIssue[]

  constructor(message: string, issues: readonly ObjectQueryIssue[] = []) {
    super(message)
    this.name = "SixbQueryError"
    this.issues = issues
  }
}

export interface SixbQueryClientOptions {
  /** hey-api client override (base url, auth, fetch). Defaults to the global client. */
  client?: Client
}

// Value types are typed as "none registered": custom value-type refs resolve
// like a runtime without them, and the empty tuple keeps property-value
// inference shallow enough for TypeScript's recursion limits.
type ClientRegisteredObjectTypes<TObjectType extends ObjectTypeWithPropertyTokens> =
  | TObjectType
  | Extract<SixbObjectTypeMap[keyof SixbObjectTypeMap], ObjectTypeWithPropertyTokens>

export type ClientObjectQueryBuilder<TObjectType extends ObjectTypeWithPropertyTokens> =
  ObjectQueryBuilder<TObjectType, ClientRegisteredObjectTypes<TObjectType>, readonly []>

export function objects<TObjectType extends ObjectTypeWithPropertyTokens>(
  objectType: TObjectType,
  options?: SixbQueryClientOptions
): { query: () => ClientObjectQueryBuilder<TObjectType> } {
  return {
    query: () =>
      createObjectQueryBuilder<TObjectType, ClientRegisteredObjectTypes<TObjectType>, readonly []>({
        query: { kind: "start", objectTypeId: objectType.id },
        executor: createHttpQueryExecutor(options?.client),
      }),
  }
}

export function createHttpQueryExecutor(client?: Client): ObjectQueryExecutor {
  // Pin the SDK call shape regardless of client-level config: with
  // `responseStyle: "data"` the call would return the bare body (breaking the
  // `{ data, error }` destructuring below), and with `throwOnError: true`
  // failures would throw raw SDK errors instead of mapping to SixbQueryError.
  const callOptions = { client, responseStyle: "fields", throwOnError: false } as const

  return {
    async list(query: ObjectQuery, options?: { includeTotal?: boolean }) {
      const { data, error } = await queryObjects({
        ...callOptions,
        body: { query: toWireQuery(query), includeTotal: options?.includeTotal },
      })
      if (error || !data) throw toSixbQueryError(error)
      return {
        objects: data.objects.map(reviveQueryRow),
        hasMore: data.hasMore,
        total: data.total,
        nextPageToken: data.nextPageToken,
      }
    },

    async count(query: ObjectQuery) {
      const { data, error } = await countObjects({
        ...callOptions,
        body: { query: toWireQuery(query) },
      })
      if (error || !data) throw toSixbQueryError(error)
      return data.count
    },

    async exists(query: ObjectQuery) {
      const { data, error } = await existsObjects({
        ...callOptions,
        body: { query: toWireQuery(query) },
      })
      if (error || !data) throw toSixbQueryError(error)
      return data.exists
    },

    async facets(query: ObjectQuery, facets: readonly ObjectQueryExecutorFacetRequest[]) {
      const { data, error } = await facetObjects({
        ...callOptions,
        body: { query: toWireQuery(query), facets: [...facets] },
      })
      if (error || !data) throw toSixbQueryError(error)
      return data.facets.map((facet) => ({
        propertyId: facet.propertyId,
        buckets: [...facet.buckets],
      }))
    },
  }
}

// Revive a query row tree: parse ISO timestamps to Date at every hop and carry
// the `links` attached by `expand` nodes (with edge `linkProperties`). The
// builder types `links` precisely; here it flows through as runtime data.
function reviveQueryRow(row: ObjectQueryObject): ObjectQueryExecutorRow {
  const revived: ObjectQueryExecutorRow = {
    primaryId: row.primaryId,
    objectTypeId: row.objectTypeId,
    properties: row.properties,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  }
  if (row.links) {
    const links: Record<string, ObjectQueryExecutorLinkValue> = {}
    for (const [linkId, value] of Object.entries(row.links)) {
      links[linkId] = reviveLinkValue(value)
    }
    revived.links = links
  }
  return revived
}

function reviveLinkValue(
  value: ObjectQueryObject | ObjectQueryObject[] | null
): ObjectQueryExecutorLinkValue {
  if (value === null) return null
  if (Array.isArray(value)) return value.map(reviveExpandedRow)
  return reviveExpandedRow(value)
}

function reviveExpandedRow(row: ObjectQueryObject): ObjectQueryExecutorExpandedRow {
  const revived: ObjectQueryExecutorExpandedRow = reviveQueryRow(row)
  if (row.linkProperties !== undefined) revived.linkProperties = row.linkProperties
  return revived
}

// The generated wire type mirrors the core IR JSON schema; they differ only in
// readonly-ness, which a structural cast cannot bridge.
function toWireQuery(query: ObjectQuery): WireObjectQuery {
  return query as unknown as WireObjectQuery
}

function toSixbQueryError(error: unknown): SixbQueryError {
  if (error && typeof error === "object" && "error" in error) {
    const body = error as { error: unknown; issues?: ObjectQueryIssue[] }
    return new SixbQueryError(`[SixbClient] ${String(body.error)}`, body.issues ?? [])
  }
  return new SixbQueryError("[SixbClient] Object query request failed")
}
