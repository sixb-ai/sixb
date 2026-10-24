import { type AuthorizationContext, canViewActionRun, isAllowed } from "../authorization"
import { AuthorizationError } from "../authorization/errors"
import type { ResolvedRuntimeAuthorization } from "../execution/authorization"
import { type AuthorizedObjectReader, readerClearance } from "../execution/authorized-object-reader"
import type { Storage } from "../storage"
import type { ActionRunRecord } from "../storage/action-runs"
import { findPrimitiveParentRequestExecution } from "../storage/executions/run-link"
import { objectBatchKey } from "../storage/objects/keys"
import type { ActionObjectSubject } from "./types"

/**
 * The runs among these a principal may view. `canViewActionRun` decides on the subject's type,
 * which a type the principal views through a condition fails: a run on one is viewable while the
 * condition shows its subject now. A deleted subject shows nothing, so its runs stay hidden.
 */
export async function viewableActionRuns<
  TRun extends Pick<ActionRunRecord, "actionId" | "subject">,
>(
  objectReader: AuthorizedObjectReader,
  authorization: AuthorizationContext | null | undefined,
  runs: readonly TRun[]
): Promise<readonly TRun[]> {
  if (!authorization) return runs

  const subjectThroughCondition = (run: TRun): ActionObjectSubject | undefined =>
    run.subject.kind === "object" &&
    authorization.viewConditions?.has(run.subject.objectTypeId) === true &&
    isAllowed(authorization, { kind: "action.apply", actionId: run.actionId })
      ? run.subject
      : undefined

  const subjects = runs.flatMap((run) => subjectThroughCondition(run) ?? [])
  const shown = subjects.length === 0 ? new Set() : await readableSubjects(objectReader, subjects)

  return runs.filter((run) => {
    if (canViewActionRun(authorization, run)) return true

    const subject = subjectThroughCondition(run)
    return (
      subject !== undefined && shown.has(objectBatchKey(subject.objectTypeId, subject.primaryId))
    )
  })
}

/**
 * The action subjects the reader reads now, by `objectBatchKey`: object type grants, conditions,
 * markings and existence alike. One batch per object type, as a type the reader cannot see fails
 * its whole batch.
 */
export async function readableSubjects(
  objectReader: AuthorizedObjectReader,
  subjects: readonly ActionObjectSubject[]
): Promise<ReadonlySet<string>> {
  const byType = new Map<string, Map<string, ActionObjectSubject>>()
  for (const subject of subjects) {
    const items = byType.get(subject.objectTypeId) ?? new Map()
    items.set(subject.primaryId, subject)
    byType.set(subject.objectTypeId, items)
  }

  const readable = new Set<string>()
  await Promise.all(
    [...byType.values()].map(async (items) => {
      try {
        const rows = await objectReader.getByPrimaryIdBatch({ items: [...items.values()] })
        for (const key of rows.keys()) {
          readable.add(key)
        }
      } catch (error) {
        if (!(error instanceof AuthorizationError)) {
          throw error
        }
      }
    })
  )
  return readable
}

/**
 * Whether the reader can read the object type of a run's subject under the markings of the
 * versions projections applied. A run names its subject's id, so a run on a type the reader
 * cannot read is hidden like one on a type it has no view grant for.
 */
export async function canReadActionRunSubject(
  objectReader: AuthorizedObjectReader,
  run: Pick<ActionRunRecord, "subject">
): Promise<boolean> {
  if (run.subject.kind !== "object") return true
  const clearance = await readerClearance(objectReader)
  return clearance?.unreadableType(run.subject.objectTypeId) === undefined
}

/** The object types whose runs the reader cannot read, to leave out of a run listing. */
export async function unreadableActionRunTypes(
  objectReader: AuthorizedObjectReader
): Promise<ReadonlySet<string>> {
  const clearance = await readerClearance(objectReader)
  return new Set(clearance?.unreadable().types.keys())
}

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
  readonly run: Pick<ActionRunRecord, "id" | "actionId" | "executionId">
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
