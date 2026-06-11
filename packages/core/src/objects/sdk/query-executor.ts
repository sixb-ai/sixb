/**
 * Execution contract for the fluent object query builder.
 *
 * The builder only constructs query IR; terminals delegate here. The server
 * runtime implements this against storage, and `@sixb/client` implements it
 * against the HTTP query routes, so both share one builder.
 */
import type { ObjectQueryFacetResult } from "../../runtime/types"
import type { ObjectQueryExplanation } from "../query/explain"
import type { ObjectQuery } from "../query/ir"
import type { ValidatedObjectQuery } from "../query/validate"

export type ObjectQueryExecutorRow = {
  primaryId: string
  objectTypeId: string
  properties: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

export type ObjectQueryExecutorListResult = {
  objects: readonly ObjectQueryExecutorRow[]
  hasMore: boolean
  total?: number
  nextPageToken?: string
}

export type ObjectQueryExecutorFacetRequest = {
  propertyId: string
  limit: number
}

export interface ObjectQueryExecutor {
  list(
    query: ObjectQuery,
    options?: { includeTotal?: boolean }
  ): Promise<ObjectQueryExecutorListResult>
  count(query: ObjectQuery): Promise<number>
  exists(query: ObjectQuery): Promise<boolean>
  facets(
    query: ObjectQuery,
    facets: readonly ObjectQueryExecutorFacetRequest[]
  ): Promise<ObjectQueryFacetResult[]>
  /** Validation requires ontology access and is unavailable on remote executors. */
  validate?(query: ObjectQuery): ValidatedObjectQuery
  /** Explanation requires ontology access and is unavailable on remote executors. */
  explain?(query: ObjectQuery): ObjectQueryExplanation
}
