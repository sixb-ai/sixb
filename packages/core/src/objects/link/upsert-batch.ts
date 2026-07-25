/**
 * Leaf operation: batch upsert links through the ontology Materializer.
 *
 * Takes SixbRuntimeContext (shared infra) + per-item pre-resolved data, because each item can target
 * a different objectType + linkDefinition. Everything valid is submitted as one ordered
 * continue-mode commit.
 */

import { assertPrivileged } from "../../authorization"
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
import { collectEndpointLookups, loadEndpointExistence, requireEndpoints } from "./endpoints"

export async function upsertLinkBatch(
  ctx: SixbRuntimeContext,
  items: readonly ResolvedLinkBatchItem[]
): Promise<readonly BatchItemResult<void>[]> {
  assertPrivileged(ctx, "upsertLinkBatch")
  const { ontology } = ctx
  if (items.length === 0) return []

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
        label: `link '${edge}'`,
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
