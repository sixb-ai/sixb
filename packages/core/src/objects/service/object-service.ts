/**
 * Service layer for object upsert operations.
 *
 * Resolves objectTypeId to a typed context and delegates to leaf functions.
 */
import { OntologyValidationError } from "../../ontology/errors"
import type { BatchItemResult, ParioRuntimeContext } from "../../runtime/types"
import type { ObjectRow } from "../../storage"
import { resolveObjectContext } from "../context"
import {
  upsertObjectBatch as upsertObjectBatchLeaf,
  upsertObject as upsertObjectLeaf,
} from "../object"

export async function upsertObject(
  runtime: ParioRuntimeContext,
  objectTypeId: string,
  properties: Record<string, unknown>
): Promise<ObjectRow> {
  const ctx = resolveObjectContext(runtime, objectTypeId)
  const primaryId = properties[ctx.primaryPropertyId]
  if (primaryId === undefined || primaryId === null) {
    throw new OntologyValidationError(
      `Missing primary property '${ctx.primaryPropertyId}' in upsert for '${objectTypeId}'`
    )
  }
  return upsertObjectLeaf(ctx, String(primaryId), properties)
}

export async function upsertObjectBatch(
  runtime: ParioRuntimeContext,
  objectTypeId: string,
  items: readonly { properties: Record<string, unknown> }[]
): Promise<readonly BatchItemResult<ObjectRow>[]> {
  const ctx = resolveObjectContext(runtime, objectTypeId)
  return upsertObjectBatchLeaf(ctx, items)
}
