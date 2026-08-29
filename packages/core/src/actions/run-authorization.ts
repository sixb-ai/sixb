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
  const subject = input.run.subject
  if (
    !input.authority.delegation ||
    subject.kind !== "object" ||
    !input.authority.actionApply.some(
      (target) =>
        target.actionId === input.run.actionId &&
        target.subject.objectTypeId === subject.objectTypeId &&
        target.subject.primaryId === subject.primaryId
    )
  ) {
    return false
  }
  return actionRunBelongsToShareGrant({
    storage: input.storage,
    projectId: input.projectId,
    run: input.run,
    grantId: input.authority.delegation.grantId,
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
