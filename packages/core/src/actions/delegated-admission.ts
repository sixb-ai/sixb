import { AuthorizationError } from "../authorization"
import type { ResolvedRuntimeAuthorization } from "../execution/authorization"
import {
  type AuthorizedObjectReader,
  assertAuthorizedObjectReaderBinding,
} from "../execution/authorized-object-reader"
import type { ExecutionContext, RuntimeAuthorization } from "../execution/types"
import type { ActionDefinition, ActionObjectSubject, ActionSubject } from "./types"

type DelegatedAuthorization = Extract<ResolvedRuntimeAuthorization, { readonly type: "delegated" }>

/** Reject ungranted tuples before Action lookup can become a metadata oracle. */
export function assertDelegatedActionTarget(input: {
  readonly authorization: DelegatedAuthorization
  readonly actionId: string
  readonly subject: ActionSubject
}): ActionObjectSubject {
  const { actionId, authorization, subject } = input
  if (
    subject.kind !== "object" ||
    !authorization.actionApply.some(
      (target) =>
        target.actionId === actionId &&
        target.subject.objectTypeId === subject.objectTypeId &&
        target.subject.primaryId === subject.primaryId
    )
  ) {
    throw denied(actionId, subject)
  }
  return subject
}

/** Admit an exact tuple against its definition and current selected-read visibility. */
export async function admitDelegatedObjectAction(input: {
  readonly objectReader: AuthorizedObjectReader
  readonly runtimeAuthorization: RuntimeAuthorization
  readonly execution: ExecutionContext
  readonly authorization: DelegatedAuthorization
  readonly action: ActionDefinition
  readonly subject: ActionObjectSubject
}): Promise<void> {
  const { action, authorization, execution, objectReader, runtimeAuthorization, subject } = input
  assertDelegatedActionTarget({ authorization, actionId: action.id, subject })
  if (action.binding.kind !== "object" || action.binding.objectType.id !== subject.objectTypeId) {
    throw denied(action.id, subject)
  }

  assertAuthorizedObjectReaderBinding({
    reader: objectReader,
    scope: { execution, authorization: runtimeAuthorization },
  })

  try {
    const visible = await objectReader.getByPrimaryId({
      objectTypeId: subject.objectTypeId,
      primaryId: subject.primaryId,
    })
    if (!visible) throw denied(action.id, subject)
  } catch (error) {
    if (error instanceof AuthorizationError) throw denied(action.id, subject)
    throw error
  }
}

function denied(actionId: string, subject: ActionSubject): AuthorizationError {
  const target =
    subject.kind === "object" ? `${subject.objectTypeId}:${subject.primaryId}` : "global"
  return new AuthorizationError(
    `apply:action:${actionId}:${target}`,
    `[Sixb] Delegated authority cannot apply Action '${actionId}' to '${target}'.`
  )
}
