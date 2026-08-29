/**
 * Service layer for object upsert operations.
 *
 * Resolves objectTypeId to a typed context and delegates to leaf functions.
 */
import { assertCanEdit } from "../../authorization"
import type { BatchItemResult, SixbRuntimeContext } from "../../runtime/types"
import type { ObjectRow } from "../../storage"
import { resolveObjectContext } from "../context"
import {
  upsertObjectBatch as upsertObjectBatchLeaf,
  upsertObject as upsertObjectLeaf,
} from "../object"

export async function upsertObject(
  runtime: SixbRuntimeContext,
  objectTypeId: string,
  properties: Record<string, unknown>
): Promise<ObjectRow> {
  // Authorize the requested identifier before resolving it against the full internal ontology.
  // Otherwise an ungranted caller can distinguish registered from unknown type ids.
  assertCanEdit(runtime, objectTypeId)
  return upsertObjectLeaf(resolveObjectContext(runtime, objectTypeId), properties)
}

/** Upsert the object named by a transport/path identity without exposing ontology metadata. */
export async function upsertObjectByPrimaryId(
  runtime: SixbRuntimeContext,
  objectTypeId: string,
  primaryId: string,
  properties: Record<string, unknown>
): Promise<ObjectRow> {
  assertCanEdit(runtime, objectTypeId)
  const context = resolveObjectContext(runtime, objectTypeId)
  return upsertObjectLeaf(context, {
    ...properties,
    [context.primaryPropertyId]: primaryId,
  })
}

export async function upsertObjectBatch(
  runtime: SixbRuntimeContext,
  objectTypeId: string,
  items: readonly { properties: Record<string, unknown> }[]
): Promise<readonly BatchItemResult<ObjectRow>[]> {
  assertCanEdit(runtime, objectTypeId)
  return upsertObjectBatchLeaf(resolveObjectContext(runtime, objectTypeId), items)
}
