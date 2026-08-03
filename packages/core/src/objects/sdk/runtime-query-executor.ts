/**
 * Server-side ObjectQueryExecutor backed by the shared query executor and storage.
 * Validation, planning, fallback, and execution all run in-process here; the
 * HTTP executor in `@sixb/client` is the remote counterpart.
 */

import type { AuthorizationContext } from "../../authorization"
import type { OntologyRegistry } from "../../ontology"
import type { Storage } from "../../storage"
import {
  countObjects,
  executeObjectQuery,
  existsObjects,
  facetObjects,
  ObjectQueryPlanningError,
  objectQueryIssues,
} from "../query"
import { explainObjectQuery } from "../query/explain"
import type { ObjectQuery } from "../query/ir"
import { validateObjectQuery } from "../query/validate"
import type { ObjectQueryExecutor, ObjectQueryExecutorFacetRequest } from "./query-executor"

export function createRuntimeQueryExecutor(params: {
  projectId: string
  ontology: OntologyRegistry
  storage: Storage
  authorization?: AuthorizationContext
}): ObjectQueryExecutor {
  const { projectId, ontology, storage, authorization } = params
  const executorOptions = { ontology, storage: storage.objects, authorization }

  return {
    async list(query: ObjectQuery, options?: { includeTotal?: boolean }) {
      try {
        return await executeObjectQuery(
          { projectId, query, includeTotal: options?.includeTotal },
          executorOptions
        )
      } catch (error) {
        throw addSdkPlanningHints(error)
      }
    },

    async count(query: ObjectQuery) {
      const result = await countObjects({ projectId, query }, executorOptions)
      return result.count
    },

    async exists(query: ObjectQuery) {
      const result = await existsObjects({ projectId, query }, executorOptions)
      return result.exists
    },

    async facets(query: ObjectQuery, facets: readonly ObjectQueryExecutorFacetRequest[]) {
      const result = await facetObjects({ projectId, query, facets }, executorOptions)
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

/**
 * Restates one planner issue in terms of the SDK builder the caller actually used. Anything that is
 * not a planning rejection passes through untouched.
 */
function addSdkPlanningHints(error: unknown): unknown {
  const issues = objectQueryIssues(error)
  if (!issues?.some((issue) => issue.code === "fallback_requires_bound")) return error

  return new ObjectQueryPlanningError(
    issues.map((issue) =>
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
