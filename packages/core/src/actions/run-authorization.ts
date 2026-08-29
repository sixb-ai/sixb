import { accessPlanCanApplyActionOn } from "../authorization/access-plan"
import type { ResolvedRuntimeAuthorization } from "../execution/authorization"
import type { Storage } from "../storage"
import type { ActionRunRecord } from "../storage/action-runs"
import { findPrimitiveParentRequestExecution } from "../storage/executions/run-link"

/** Check both current grant scope and immutable request provenance for a delegated Action run. */
export async function canDelegationAccessActionRun(input: {
  readonly storage: Storage
  readonly projectId: string
  readonly authority: Extract<ResolvedRuntimeAuthorization, { readonly type: "delegated" }>
  readonly run: ActionRunRecord
}): Promise<boolean> {
  if (
    input.authority.ref.kind !== "share" ||
    input.run.subject.kind !== "object" ||
    !accessPlanCanApplyActionOn(input.authority.access, input.run.actionId, {
      objectTypeId: input.run.subject.objectTypeId,
      primaryId: input.run.subject.primaryId,
    })
  ) {
    return false
  }
  return actionRunBelongsToShareGrant({
    storage: input.storage,
    projectId: input.projectId,
    run: input.run,
    grantId: input.authority.ref.id,
  })
}

/** Session ids remain audit provenance; the issued grant is the durable capability identity. */
export async function actionRunBelongsToShareGrant(input: {
  readonly storage: Storage
  readonly projectId: string
  readonly run: ActionRunRecord
  readonly grantId: string
}): Promise<boolean> {
  const parent = await findPrimitiveParentRequestExecution({
    executions: input.storage.executions,
    projectId: input.projectId,
    executionId: input.run.executionId,
    primitive: { kind: "action", id: input.run.actionId, runId: input.run.id },
  })
  const authorization = parent?.authorizationRef
  return (
    authorization?.type === "delegated" &&
    authorization.delegation.kind === "share" &&
    authorization.delegation.grantId === input.grantId
  )
}
