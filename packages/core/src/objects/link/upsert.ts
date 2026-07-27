/**
 * Leaf operation: upsert a single link through the ontology Materializer.
 */
import { assertPrivileged } from "../../authorization"
import type { ResolvedLinkContext } from "../context"
import {
  commitRuntimeOperations,
  linkUpsertOperation,
  normalizeRuntimeLink,
  runtimeOperationId,
} from "../materializer-adapter"
import { collectEndpointLookups, loadEndpointExistence, requireEndpoints } from "./endpoints"

export async function upsertLink(
  ctx: ResolvedLinkContext,
  params: {
    sourceId: string
    linkId: string
    targetTypeId: string
    targetId: string
    properties?: Record<string, unknown>
  }
): Promise<void> {
  assertPrivileged(ctx, "upsertLink")
  const { objectType, linkDefinition, ontology } = ctx
  const { sourceId, linkId, targetTypeId, targetId, properties } = params
  const endpoints = { objectType, sourceId, targetTypeId, targetId }

  // Endpoint reads keep the public `ObjectNotFoundError` contract; the Materializer independently
  // refuses a link whose endpoints are not effective when it commits. This runs before property
  // normalization so the same input reports the same error class here and through the batch APIs,
  // which check endpoints first inside `plan`.
  requireEndpoints(endpoints, await loadEndpointExistence(ctx, collectEndpointLookups([endpoints])))

  const normalizedProperties = normalizeRuntimeLink({
    objectType,
    linkDefinition,
    linkId,
    targetTypeId,
    properties,
    valueTypesById: ontology.getValueTypesById(),
    isValidLinkTarget: (expected, actual) => ontology.isValidLinkTarget(expected, actual),
  })

  await commitRuntimeOperations(ctx, [
    linkUpsertOperation({
      id: runtimeOperationId(0),
      ref: {
        source: { objectTypeId: objectType.id, primaryId: sourceId },
        linkId,
        target: { objectTypeId: targetTypeId, primaryId: targetId },
      },
      ...(normalizedProperties !== undefined ? { properties: normalizedProperties } : {}),
    }),
  ])
}
