import type {
  ActionDefinition,
  ActionObjectSubject,
  ActionReadFacade,
  ActionReadObjectSet,
  ActionRunRecord,
  ActionRuntimeFacade,
  ActionSubject,
  ActionTargetObject,
  ObjectSetListInput,
  ObjectTypeWithPropertyTokens,
  ValueType,
} from "@sixb/core"
import { isObjectActionDefinition, ObjectNotFoundError } from "@sixb/core"
import { ActionWorkerError } from "../errors"
import type { RunActionJobInput } from "../types"
import type { LoadedObjectTarget } from "./types"

type RuntimeReadObjectSet = {
  get(id: string): Promise<unknown>
  query(): unknown
  list(input?: ObjectSetListInput): Promise<unknown>
  byId(id: string): {
    get(): Promise<unknown>
  }
}

export function toActionRuntimeFacade(runtime: RunActionJobInput["runtime"]): ActionRuntimeFacade {
  return {
    objects(objectType) {
      return {
        appendTelemetryBatch(items) {
          return runtime.sixb.appendTelemetry(objectType.id, items)
        },
      }
    },
    connector(definition) {
      return runtime.sixb.connector(definition)
    },
  }
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
    snapshot: toActionTargetObject(targetRow, input.action.binding.objectType.id),
  }
}

export function createReadFacade(sixb: RunActionJobInput["runtime"]["sixb"]): ActionReadFacade {
  const facade = {
    objects<const TObjectType extends ObjectTypeWithPropertyTokens>(objectType: TObjectType) {
      return createReadObjectSetAdapter<TObjectType>(
        sixb.objects(objectType) as RuntimeReadObjectSet
      )
    },
  }
  // The worker only knows the widened ontology; action validation already checked the
  // object type, so the read facade can restore the narrow type chosen by the handler.
  return facade as ActionReadFacade
}

function createReadObjectSetAdapter<TObjectType extends ObjectTypeWithPropertyTokens>(
  objectSet: RuntimeReadObjectSet
): ActionReadObjectSet<TObjectType, readonly ValueType[], ObjectTypeWithPropertyTokens> {
  type TypedReadObjectSet = ActionReadObjectSet<
    TObjectType,
    readonly ValueType[],
    ObjectTypeWithPropertyTokens
  >

  return {
    get(id) {
      return objectSet.get(id) as ReturnType<TypedReadObjectSet["get"]>
    },
    query() {
      return objectSet.query() as ReturnType<TypedReadObjectSet["query"]>
    },
    list(input) {
      return objectSet.list(input) as ReturnType<TypedReadObjectSet["list"]>
    },
    byId(id) {
      const handle = objectSet.byId(id)
      return {
        get() {
          return handle.get() as ReturnType<ReturnType<TypedReadObjectSet["byId"]>["get"]>
        },
      }
    },
  }
}

export function requireObjectSubject<
  TObjectType extends ObjectTypeWithPropertyTokens = ObjectTypeWithPropertyTokens,
>(subject: ActionSubject, actionId: string): ActionObjectSubject<TObjectType> {
  if (subject.kind !== "object") {
    throw new ActionWorkerError(`Action '${actionId}' requires an object subject.`)
  }
  return subject as ActionObjectSubject<TObjectType>
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
