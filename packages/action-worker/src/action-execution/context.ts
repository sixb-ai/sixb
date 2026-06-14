import type {
  ActionDefinition,
  ActionReadFacade,
  ActionRunRecord,
  ActionRuntimeFacade,
  ActionSubject,
  ActionTargetObject,
  ObjectSetListInput,
  ObjectTypeWithPropertyTokens,
} from "@sixb/core"
import { isObjectActionDefinition, ObjectNotFoundError } from "@sixb/core"
import { ActionWorkerError } from "../errors"
import type { RunActionJobInput } from "../types"
import type { LoadedObjectTarget } from "./types"

export function toActionRuntimeFacade(runtime: RunActionJobInput["runtime"]): ActionRuntimeFacade {
  return runtime.sixb as unknown as ActionRuntimeFacade
}

function toActionTargetObject(
  row: {
    primaryId: string
    objectTypeId: string
    properties: Record<string, unknown>
    createdAt: Date
    updatedAt: Date
  },
  declaredObjectTypeId: string
): ActionTargetObject {
  return {
    primaryId: row.primaryId,
    objectTypeId: declaredObjectTypeId,
    properties: row.properties,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function createBasePhaseContext(input: {
  readonly runtime: RunActionJobInput["runtime"]
  readonly run: ActionRunRecord
  readonly signal: AbortSignal
}) {
  return {
    run: {
      id: input.run.id,
      startedAt: input.run.startedAt ?? input.run.queuedAt,
      idempotencyKey: input.run.idempotencyKey,
    },
    params: input.run.params,
    subject: input.run.subject,
    signal: input.signal,
  }
}

export type BasePhaseContext = ReturnType<typeof createBasePhaseContext>

export async function loadObjectTarget(input: {
  readonly runtime: RunActionJobInput["runtime"]
  readonly action: ActionDefinition
  readonly run: ActionRunRecord
}): Promise<LoadedObjectTarget | null> {
  if (!isObjectActionDefinition(input.action)) {
    if (input.run.subject.kind !== "none") {
      throw new ActionWorkerError(`Action '${input.action.id}' does not accept a subject.`)
    }
    return null
  }

  const subject = requireObjectSubject(input.run.subject, input.action.id)
  const subjectObjectType = input.runtime.sixb.resolveObjectType(subject.objectTypeId)
  const actionAppliesToSubject = input.runtime.sixb
    .getActionsForType(subjectObjectType)
    .some((candidate) => candidate.id === input.action.id)
  if (!actionAppliesToSubject) {
    throw new ActionWorkerError(
      `Action '${input.action.id}' is not valid for object type '${subjectObjectType.id}'.`
    )
  }

  const targetRow = await input.runtime.storage.objects.getByPrimaryId({
    projectId: input.runtime.id,
    objectTypeId: subjectObjectType.id,
    primaryId: subject.primaryId,
  })
  if (!targetRow) {
    throw new ObjectNotFoundError(
      subject.objectTypeId,
      subject.primaryId,
      "Object not found for action run"
    )
  }

  return {
    subjectObjectType,
    snapshot: toActionTargetObject(targetRow, input.action.target.id),
  }
}

export function createReadFacade(sixb: RunActionJobInput["runtime"]["sixb"]): ActionReadFacade {
  const facade = {
    objects(objectType: ObjectTypeWithPropertyTokens) {
      const objectSet = sixb.objects(objectType)
      return {
        get(id: string) {
          return objectSet.get(id)
        },
        query() {
          return objectSet.query()
        },
        list(input?: ObjectSetListInput) {
          return objectSet.list(input)
        },
        byId(id: string) {
          const handle = objectSet.byId(id)
          return {
            get() {
              return handle.get()
            },
          }
        },
      }
    },
  }
  return facade as unknown as ActionReadFacade
}

export function requireObjectSubject(
  subject: ActionSubject,
  actionId: string
): Extract<ActionSubject, { kind: "object" }> {
  if (subject.kind !== "object") {
    throw new ActionWorkerError(`Action '${actionId}' requires an object subject.`)
  }
  return subject
}

export function requireObjectTarget(
  target: LoadedObjectTarget | null,
  actionId: string
): LoadedObjectTarget {
  if (!target) {
    throw new ActionWorkerError(`Action '${actionId}' requires an object target.`)
  }
  return target
}

export function toEffectTarget(
  subject: ActionSubject,
  actionId: string
): {
  readonly objectTypeId: string
  readonly primaryId: string
} {
  const objectSubject = requireObjectSubject(subject, actionId)
  return {
    objectTypeId: objectSubject.objectTypeId,
    primaryId: objectSubject.primaryId,
  }
}
