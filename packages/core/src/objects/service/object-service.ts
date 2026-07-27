/**
 * Service layer for object upsert operations.
 *
 * Resolves objectTypeId to a typed context and delegates to leaf functions.
 */
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
  return upsertObjectLeaf(resolveObjectContext(runtime, objectTypeId), properties)
}

export async function upsertObjectBatch(
  runtime: SixbRuntimeContext,
  objectTypeId: string,
  items: readonly { properties: Record<string, unknown> }[]
): Promise<readonly BatchItemResult<ObjectRow>[]> {
  return upsertObjectBatchLeaf(resolveObjectContext(runtime, objectTypeId), items)
}
