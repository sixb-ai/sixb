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

  const normalizedProperties = normalizeRuntimeLink({
    objectType,
    linkDefinition,
    linkId,
    targetTypeId,
    properties,
    valueTypesById: ontology.getValueTypesById(),
    isValidLinkTarget: (expected, actual) => ontology.isValidLinkTarget(expected, actual),
  })

  // Endpoint reads keep the public `ObjectNotFoundError` contract; the Materializer independently
  // refuses a link whose endpoints are not effective when it commits.
  requireEndpoints(endpoints, await loadEndpointExistence(ctx, collectEndpointLookups([endpoints])))

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
