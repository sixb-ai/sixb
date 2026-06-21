/**
 * Compatibility leaf operation: request an action on an object.
 *
 * The canonical action request path lives in `actions/request.ts`; object-bound
 * helpers delegate here by supplying an object subject.
 */
import {
  type RequestActionAndWaitOptions,
  type RequestActionOptions,
  type RequestActionResult,
  requestAction as requestRuntimeAction,
  requestActionAndWait as requestRuntimeActionAndWait,
} from "../../actions/request"
import type { ActionRunRecord } from "../../storage"
import type { ResolvedObjectContext } from "../context"

export type { RequestActionAndWaitOptions, RequestActionOptions }

export async function requestAction(
  ctx: ResolvedObjectContext,
  params: {
    primaryId: string
    actionId: string
    params?: Record<string, unknown>
    options?: RequestActionOptions
  }
): Promise<RequestActionResult> {
  return requestRuntimeAction(ctx, {
    actionId: params.actionId,
    subject: {
      kind: "object",
      objectTypeId: ctx.objectType.id,
      primaryId: params.primaryId,
    },
    params: params.params,
    runId: params.options?.runId,
    signal: params.options?.signal,
  })
}

export async function requestActionAndWait(
  ctx: ResolvedObjectContext,
  params: {
    primaryId: string
    actionId: string
    params?: Record<string, unknown>
    options?: RequestActionAndWaitOptions
  }
): Promise<ActionRunRecord> {
  return requestRuntimeActionAndWait(ctx, {
    actionId: params.actionId,
    subject: {
      kind: "object",
      objectTypeId: ctx.objectType.id,
      primaryId: params.primaryId,
    },
    params: params.params,
    runId: params.options?.runId,
    timeoutMs: params.options?.timeoutMs,
    signal: params.options?.signal,
    onRequested: params.options?.onRequested,
  })
}
