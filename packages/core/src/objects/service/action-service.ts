/**
 * Service layer for action operations.
 *
 * Resolves objectTypeId to a typed context and delegates to the leaf function.
 */

import type { RequestActionResult } from "../../actions/request"
import type { ExecutionContext } from "../../execution"
import type { SixbRuntimeContext } from "../../runtime/types"
import type { ActionRunRecord } from "../../storage"
import {
  type RequestActionAndWaitOptions,
  type RequestActionOptions,
  requestActionAndWait as requestActionAndWaitLeaf,
  requestAction as requestActionLeaf,
} from "../action"
import { resolveObjectContext } from "../context"

export async function requestAction(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  objectTypeId: string,
  primaryId: string,
  actionId: string,
  params?: Record<string, unknown>,
  options?: RequestActionOptions
): Promise<RequestActionResult> {
  const ctx = { ...resolveObjectContext(runtime, objectTypeId), execution }
  return requestActionLeaf(ctx, { primaryId, actionId, params, options })
}

export async function requestActionAndWait(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  objectTypeId: string,
  primaryId: string,
  actionId: string,
  params?: Record<string, unknown>,
  options?: RequestActionAndWaitOptions
): Promise<ActionRunRecord> {
  const ctx = { ...resolveObjectContext(runtime, objectTypeId), execution }
  return requestActionAndWaitLeaf(ctx, { primaryId, actionId, params, options })
}
