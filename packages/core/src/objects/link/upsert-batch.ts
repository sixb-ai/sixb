/**
 * Leaf operation: batch upsert links through the ontology Materializer.
 *
 * Takes SixbRuntimeContext (shared infra) + per-item pre-resolved data, because each item can target
 * a different objectType + linkDefinition. Everything valid is submitted as one ordered
 * continue-mode commit.
 */

import { stableJsonStringify } from "../../json"
import { linkRefKey } from "../../materialization/refs"
import type { BatchItemResult, SixbRuntimeContext } from "../../runtime/types"
import type { ResolvedLinkBatchItem } from "../context"
import {
  linkUpsertOperation,
  normalizeRuntimeLink,
  runtimeOperationId,
} from "../materializer-adapter"
import { runRuntimeItemBatch } from "../runtime-batch"
import { assertCanWriteLink } from "./authorization"
import { collectEndpointLookups, loadEndpointExistence, requireEndpoints } from "./endpoints"

export async function upsertLinkBatch(
  ctx: SixbRuntimeContext,
  items: readonly ResolvedLinkBatchItem[]
): Promise<readonly BatchItemResult<void>[]> {
  const { ontology } = ctx
  if (items.length === 0) return []

  // Every item, up front, and before the endpoint lookup below. Authorization is a precondition, not
  // a per-item validation: a refused item must not become one failed `BatchItemResult` while the
  // rest of the batch commits. Asserting inside `plan` would do exactly that, and would also let the
  // existence lookup answer for targets the principal cannot see.
  for (const item of items) {
    assertCanWriteLink(ctx, {
      sourceTypeId: item.objectType.id,
      targetTypeId: item.targetTypeId,
    })
  }

  const existing = await loadEndpointExistence(ctx, collectEndpointLookups(items))
  const valueTypesById = ontology.getValueTypesById()

  return runRuntimeItemBatch({
    ctx,
    items,
    plan(item, index) {
      requireEndpoints(item, existing)
      const properties = normalizeRuntimeLink({
        objectType: item.objectType,
        linkDefinition: item.linkDefinition,
        linkId: item.linkId,
        targetTypeId: item.targetTypeId,
        properties: item.properties,
        valueTypesById,
        isValidLinkTarget: (expected, actual) => ontology.isValidLinkTarget(expected, actual),
      })
      const ref = {
        source: { objectTypeId: item.objectType.id, primaryId: item.sourceId },
        linkId: item.linkId,
        target: { objectTypeId: item.targetTypeId, primaryId: item.targetId },
      }
      const edge = linkRefKey(ref)
      return {
        key: edge,
        // The key is a JSON array, which is unreadable in the error an operator sees on a failed
        // link projection. Name the edge the way the object path names an object.
        label: `link '${item.objectType.id}:${item.sourceId}.${item.linkId} -> ${item.targetTypeId}:${item.targetId}'`,
        fingerprint: stableJsonStringify(properties ?? null),
        operations: [
          linkUpsertOperation({
            id: runtimeOperationId(index),
            ref,
            ...(properties !== undefined ? { properties } : {}),
          }),
        ],
      }
    },
    value: () => undefined,
  })
}
