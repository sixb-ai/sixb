/**
 * Compatibility leaf operation: request an action on an object.
 *
 * The canonical action request path lives in `actions/request.ts`; object-bound
 * helpers delegate here by supplying an object subject.
 */
import {
  type RequestActionOptions,
  requestAction as requestRuntimeAction,
} from "../../actions/request"
import type { ActionRunRecord } from "../../storage"
import type { ExecutionObjectContext } from "../context"

export type { RequestActionOptions }

export async function requestAction(
  ctx: ExecutionObjectContext,
  params: {
    primaryId: string
    actionId: string
    params?: Record<string, unknown>
    options?: RequestActionOptions
  }
): Promise<ActionRunRecord> {
  return requestRuntimeAction(ctx, ctx.execution, {
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
