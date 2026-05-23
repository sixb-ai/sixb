/**
 * Service layer for action operations.
 *
 * Resolves objectTypeId to a typed context and delegates to the leaf function.
 */
import type { SixbRuntimeContext } from "../../runtime/types"
import {
  type RequestActionAndWaitOptions,
  type RequestActionOptions,
  requestActionAndWait as requestActionAndWaitLeaf,
  requestAction as requestActionLeaf,
} from "../action"
import { resolveObjectContext } from "../context"

export async function requestAction(
  runtime: SixbRuntimeContext,
  objectTypeId: string,
  primaryId: string,
  actionId: string,
  params?: Record<string, unknown>,
  options?: RequestActionOptions
): Promise<{ runId: string }> {
  const ctx = resolveObjectContext(runtime, objectTypeId)
  return requestActionLeaf(ctx, { primaryId, actionId, params, options })
}

export async function requestActionAndWait(
  runtime: SixbRuntimeContext,
  objectTypeId: string,
  primaryId: string,
  actionId: string,
  params?: Record<string, unknown>,
  options?: RequestActionAndWaitOptions
): Promise<{ runId: string }> {
  const ctx = resolveObjectContext(runtime, objectTypeId)
  return requestActionAndWaitLeaf(ctx, { primaryId, actionId, params, options })
}
