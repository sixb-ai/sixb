/**
 * Server-side ObjectQueryExecutor backed by the shared query executor and storage.
 * Validation, planning, fallback, and execution all run in-process here; the
 * HTTP executor in `@sixb/client` is the remote counterpart.
 */

import type { AuthorizedObjectReader } from "../../execution/authorized-object-reader"
import type { OntologyRegistry } from "../../ontology"
import { ObjectQueryPlanningError } from "../query"
import { explainObjectQuery } from "../query/explain"
import type { ObjectQuery } from "../query/ir"
import { validateObjectQuery } from "../query/validate"
import type { ObjectQueryExecutor, ObjectQueryExecutorFacetRequest } from "./query-executor"

export function createRuntimeQueryExecutor(params: {
  ontology: OntologyRegistry
  objectReader: AuthorizedObjectReader
}): ObjectQueryExecutor {
  const { ontology, objectReader } = params

  return {
    async list(query: ObjectQuery, options?: { includeTotal?: boolean }) {
      try {
        return await objectReader.executeQuery({ query, includeTotal: options?.includeTotal })
      } catch (error) {
        if (error instanceof ObjectQueryPlanningError) {
          throw addSdkPlanningHints(error)
        }
        throw error
      }
    },

    async count(query: ObjectQuery) {
      const result = await objectReader.count({ query })
      return result.count
    },

    async exists(query: ObjectQuery) {
      const result = await objectReader.exists({ query })
      return result.exists
    },

    async facets(query: ObjectQuery, facets: readonly ObjectQueryExecutorFacetRequest[]) {
      const result = await objectReader.facet({ query, facets })
      return result.facets.map((facet) => ({
        propertyId: facet.propertyId,
        buckets: [...facet.buckets],
      }))
    },

    validate(query: ObjectQuery) {
      return validateObjectQuery(query, { ontology, normalize: false })
    },

    explain(query: ObjectQuery) {
      return explainObjectQuery(query, { ontology, normalize: false })
    },
  }
}

function addSdkPlanningHints(error: ObjectQueryPlanningError): ObjectQueryPlanningError {
  if (!error.issues.some((issue) => issue.code === "fallback_requires_bound")) return error

  return new ObjectQueryPlanningError(
    error.issues.map((issue) =>
      issue.code === "fallback_requires_bound"
        ? {
            ...issue,
            message:
              "Object query fallback requires an explicit result bound. Add .limit(n) or .page({ pageSize: n }) before .list().",
          }
        : issue
    )
  )
}
