/**
 * Typed object queries over HTTP (`@sixb/client/query`).
 *
 * `objects(Type)` returns the same fluent query builder the server runtime
 * uses, wired to the object query routes through the generated SDK. Queries
 * are validated server-side; failures surface as `SixbQueryError`.
 */

import type {
  ObjectQuery,
  ObjectQueryBuilder,
  ObjectQueryExecutor,
  ObjectQueryExecutorExpandedRow,
  ObjectQueryExecutorFacetRequest,
  ObjectQueryExecutorLinkValue,
  ObjectQueryExecutorRow,
  ObjectQueryRow,
  ObjectTypeWithPropertyTokens,
  TwinObject,
  UniquePropertyToken,
  UniquePropertyValue,
} from "@sixb/core/query"
import { createObjectQueryBuilder } from "@sixb/core/query"
import { isSixbApiError, SixbApiError } from "./api"
import type { Client } from "./generated/client"
import {
  countObjects,
  existsObjects,
  facetObjects,
  getObjectByUniqueProperty,
  queryObjects,
} from "./generated/sdk.gen"
import type {
  ObjectQueryIssue,
  ObjectQueryObject,
  ObjectQuery as WireObjectQuery,
} from "./generated/types.gen"

export type { ObjectQueryIssue }
export type { CurrentUserRef } from "@sixb/core/ontology"
export { currentUser } from "@sixb/core/ontology"

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

export type ClientObjectQueryBuilder<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TRow = ObjectQueryRow<TObjectType>,
> = ObjectQueryBuilder<TObjectType, TRow>

export interface ClientObjectSet<TObjectType extends ObjectTypeWithPropertyTokens> {
  query(): ClientObjectQueryBuilder<TObjectType>
  /**
   * The object of exactly this type holding a value of a unique property, or null when none does
   * or the caller may not read it. Other failures throw `SixbApiError`.
   */
  getBy<TToken extends UniquePropertyToken<TObjectType>>(
    property: TToken,
    value: UniquePropertyValue<TObjectType, TToken>
  ): Promise<TwinObject<TObjectType> | null>
}

export function objects<TObjectType extends ObjectTypeWithPropertyTokens>(
  objectType: TObjectType,
  options?: SixbQueryClientOptions
): ClientObjectSet<TObjectType> {
  return {
    query: () =>
      createObjectQueryBuilder<TObjectType>({
        query: { kind: "start", objectTypeId: objectType.id },
        executor: createHttpQueryExecutor(options?.client),
      }),
    getBy: (property, value) => {
      if (property.objectTypeId !== objectType.id) {
        throw new SixbQueryError(
          `[SixbClient] Property token ${property.objectTypeId}.${property.id} cannot be used with ${objectType.id}.`
        )
      }
      return getObjectBy(objectType, property.id, value, options?.client)
    },
  }
}

async function getObjectBy<TObjectType extends ObjectTypeWithPropertyTokens>(
  objectType: TObjectType,
  propertyId: string,
  value: unknown,
  client?: Client
): Promise<TwinObject<TObjectType> | null> {
  const { data, error, request, response } = await getObjectByUniqueProperty({
    client,
    responseStyle: "fields",
    throwOnError: false,
    path: { objectTypeId: objectType.id, propertyId },
    // Dates travel as the ISO strings writes accept.
    body: { value: value instanceof Date ? value.toISOString() : value },
  })
  if (isObjectNotFound(response?.status, error)) return null

  if (error || !data) {
    if (isSixbApiError(error)) throw error
    throw new SixbApiError("[SixbClient] Object lookup by unique property failed", {
      status: response?.status ?? 0,
      statusText: response?.statusText ?? "",
      url: request?.url ?? "",
      method: request?.method ?? "POST",
      body: error,
    })
  }

  return {
    ...data,
    createdAt: new Date(data.createdAt),
    updatedAt: new Date(data.updatedAt),
  } as unknown as TwinObject<TObjectType>
}

/** The route's own 404, which a lookup that found nothing answers; any other 404 is a failure. */
function isObjectNotFound(status: number | undefined, error: unknown): boolean {
  const body = isSixbApiError(error) ? error.body : error
  const notFound = isSixbApiError(error) ? error.status === 404 : status === 404
  return (
    notFound &&
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    body.error === "Object not found"
  )
}

export function createHttpQueryExecutor(client?: Client): ObjectQueryExecutor {
  // Pin the SDK call shape regardless of client-level config: with
  // `responseStyle: "data"` the call would return the bare body (breaking the
  // `{ data, error }` destructuring below), and with `throwOnError: true`
  // failures would throw raw SDK errors instead of mapping to SixbQueryError.
  const callOptions = { client, responseStyle: "fields", throwOnError: false } as const

  return {
    async list(query: ObjectQuery, options?: { includeTotal?: boolean; signal?: AbortSignal }) {
      const { data, error } = await queryObjects({
        ...callOptions,
        body: { query: toWireQuery(query), includeTotal: options?.includeTotal },
        signal: options?.signal,
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
      return {
        total: data.total,
        facets: data.facets.map((facet) => ({
          propertyId: facet.propertyId,
          buckets: [...facet.buckets],
        })),
      }
    },
  }
}

// Revive a query row tree: parse ISO timestamps to Date at every hop and carry
// the `redactions` of each row, and the `links` and member profiles (`users`)
// attached by `expand` nodes (with edge `linkProperties`). The builder types
// `links` and `users` precisely; here they flow through as runtime data.
function reviveQueryRow(row: ObjectQueryObject): ObjectQueryExecutorRow {
  const revived: ObjectQueryExecutorRow = {
    ...(row.score === undefined ? {} : { score: row.score }),
    primaryId: row.primaryId,
    objectTypeId: row.objectTypeId,
    properties: row.properties,
    ...(row.redactions === undefined ? {} : { redactions: row.redactions }),
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
  if (row.users) revived.users = row.users
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
  // The browser client wraps failures in `SixbApiError`; tests and bare clients
  // surface the raw response body. Unwrap to the body either way so server-sent
  // query issues survive.
  const body = isSixbApiError(error) ? error.body : error
  if (body && typeof body === "object" && "error" in body) {
    const payload = body as { error: unknown; issues?: ObjectQueryIssue[] }
    return new SixbQueryError(`[SixbClient] ${String(payload.error)}`, payload.issues ?? [])
  }
  return new SixbQueryError("[SixbClient] Object query request failed")
}
