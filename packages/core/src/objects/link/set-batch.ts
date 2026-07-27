/**
 * Leaf operation: assign cardinality-one links through the ontology Materializer.
 *
 * Assignment differs from an edge upsert: whichever target a scope currently holds is deleted before
 * the desired target is asserted. Each item therefore lowers to an ordered `link.delete` per stale
 * target followed by one `link.upsert`, all inside one continue-mode commit.
 *
 * The current target is read before the commit, so a concurrent assignment to the same scope reports
 * an item error rather than violating cardinality.
 *
 * TODO(ontology-materializer/phase-4): Delete once projection workers materialize foreign-key links
 * through `projections.replace` instead of runtime CRUD.
 */

import { assertPrivileged } from "../../authorization"
import type { OntologyObjectRef } from "../../materialization/model"
import { linkScopeKey, objectRefKey } from "../../materialization/refs"
import type { BatchItemResult, SixbRuntimeContext } from "../../runtime/types"
import type { ResolvedLinkBatchItem } from "../context"
import { ObjectError } from "../errors"
import {
  linkDeleteOperation,
  linkUpsertOperation,
  runtimeOperationId,
} from "../materializer-adapter"
import { runRuntimeItemBatch } from "../runtime-batch"
import { collectEndpointLookups, loadEndpointExistence, requireEndpoints } from "./endpoints"

type ResolvedLinkSetBatchItem = Omit<ResolvedLinkBatchItem, "properties">

export async function setLinkBatch(
  ctx: SixbRuntimeContext,
  items: readonly ResolvedLinkSetBatchItem[]
): Promise<readonly BatchItemResult<void>[]> {
  assertPrivileged(ctx, "setLinkBatch")
  if (items.length === 0) return []

  for (const item of items) {
    if (item.linkDefinition.cardinality !== "one") {
      throw new ObjectError(
        `setLinkBatch requires cardinality 'one' link '${item.objectType.id}.${item.linkId}'`
      )
    }
  }

  const existing = await loadEndpointExistence(ctx, collectEndpointLookups(items))
  const assignedTargets = await loadAssignedTargets(ctx, items)

  return runRuntimeItemBatch({
    ctx,
    items,
    plan(item, index) {
      requireEndpoints(item, existing)
      const source = { objectTypeId: item.objectType.id, primaryId: item.sourceId }
      const target = { objectTypeId: item.targetTypeId, primaryId: item.targetId }
      const ref = { source, linkId: item.linkId, target }
      const scope = linkScopeKey(source, item.linkId)
      const targetKey = objectRefKey(target)
      const stale = (assignedTargets.get(scope) ?? []).filter(
        (assigned) => objectRefKey(assigned) !== targetKey
      )

      return {
        // A scope holds one target, so a second item may only reassert the same one.
        key: scope,
        label: `assignment '${item.objectType.id}.${item.linkId}' on '${item.sourceId}'`,
        fingerprint: targetKey,
        operations: [
          ...stale.map((assigned, ordinal) =>
            linkDeleteOperation({
              id: runtimeOperationId(index, ordinal + 1),
              ref: { source, linkId: item.linkId, target: assigned },
            })
          ),
          linkUpsertOperation({ id: runtimeOperationId(index), ref }),
        ],
      }
    },
    value: () => undefined,
  })
}

/** Effective targets currently assigned to each `(source, linkId)` scope in the batch. */
async function loadAssignedTargets(
  ctx: Pick<SixbRuntimeContext, "projectId" | "storage">,
  items: readonly ResolvedLinkSetBatchItem[]
): Promise<Map<string, OntologyObjectRef[]>> {
  const lookups = new Map<
    string,
    { readonly objectTypeId: string; readonly objectId: string; readonly linkId: string }
  >()
  for (const item of items) {
    const key = `${item.objectType.id}:${item.sourceId}:${item.linkId}`
    if (lookups.has(key)) continue
    lookups.set(key, {
      objectTypeId: item.objectType.id,
      objectId: item.sourceId,
      linkId: item.linkId,
    })
  }

  const rows = await ctx.storage.objects.listLinksBatch({
    projectId: ctx.projectId,
    items: [...lookups.values()],
  })

  const assigned = new Map<string, OntologyObjectRef[]>()
  for (const [key, scope] of lookups) {
    assigned.set(
      linkScopeKey({ objectTypeId: scope.objectTypeId, primaryId: scope.objectId }, scope.linkId),
      (rows.get(key) ?? []).map((row) => ({
        objectTypeId: row.targetTypeId,
        primaryId: row.targetId,
      }))
    )
  }
  return assigned
}
