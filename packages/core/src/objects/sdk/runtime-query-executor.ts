/**
 * Server-side ObjectQueryExecutor backed by the shared query executor and storage.
 * Validation, planning, fallback, and execution all run in-process here; the
 * HTTP executor in `@sixb/client` is the remote counterpart.
 */
import type { OntologyRegistry } from "../../ontology"
import type { Storage } from "../../storage"
import {
  countObjects,
  executeObjectQuery,
  existsObjects,
  facetObjects,
  ObjectQueryPlanningError,
} from "../query"
import { explainObjectQuery } from "../query/explain"
import type { ObjectQuery } from "../query/ir"
import { validateObjectQuery } from "../query/validate"
import type { ObjectQueryExecutor, ObjectQueryExecutorFacetRequest } from "./query-executor"

export function createRuntimeQueryExecutor(params: {
  projectId: string
  ontology: OntologyRegistry
  storage: Storage
}): ObjectQueryExecutor {
  const { projectId, ontology, storage } = params
  const executorOptions = { ontology, storage: storage.objects }

  return {
    async list(query: ObjectQuery, options?: { includeTotal?: boolean }) {
      try {
        return await executeObjectQuery(
          { projectId, query, includeTotal: options?.includeTotal },
          executorOptions
        )
      } catch (error) {
        if (error instanceof ObjectQueryPlanningError) {
          throw addSdkPlanningHints(error)
        }
        throw error
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
