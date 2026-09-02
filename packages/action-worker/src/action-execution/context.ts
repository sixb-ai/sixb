import type {
  ActionDefinition,
  ActionObjectSubject,
  ActionReadFacade,
  ActionReadObjectSetSource,
  ActionRuntimeFacade,
  ActionSubject,
  ActionTargetObject,
  Logger,
  ObjectTypeWithPropertyTokens,
} from "@sixb/core"
import { isObjectActionDefinition, ObjectNotFoundError } from "@sixb/core"
import type { ActionReadRecorder } from "@sixb/core/internal/actions"
import { coerceActionParamsToTyped, createActionReadFacade } from "@sixb/core/internal/actions"
import { createSixbError } from "@sixb/core/internal/errors"
import type { ActionRunRecord } from "@sixb/core/storage"
import type { RunActionJobInput } from "../types"
import type { LoadedObjectTarget } from "./types"

export function toActionRuntimeFacade(runtime: RunActionJobInput["runtime"]): ActionRuntimeFacade {
  return {
    blobs: {
      put(input) {
        return runtime.sixb.blobs.put(input)
      },
      open(blobId) {
        return runtime.sixb.blobs.open(blobId)
      },
      stat(blobId) {
        return runtime.sixb.blobs.stat(blobId)
      },
    },
    connector: runtime.sixb.connector,
    objects(objectType) {
      return {
        appendTelemetryBatch(items) {
          return runtime.sixb.objects.appendTelemetry(objectType.id, items)
        },
      }
    },
  }
}

export function toActionReadFacade(
  runtime: RunActionJobInput["runtime"],
  recorder: ActionReadRecorder
): ActionReadFacade {
  return createActionReadFacade(
    (objectType) => runtime.sixb.objects(objectType) as ActionReadObjectSetSource,
    {
      recorder,
      resolveLinkIds: (objectTypeId) =>
        runtime.sixb.objects.resolveType(objectTypeId).links.map((definition) => definition.id),
      telemetry: {
        resolveObjectType: (objectTypeId) => runtime.sixb.objects.resolveType(objectTypeId),
        getHistoryBatch: (input) => runtime.sixb.objects.getTelemetryHistoryBatch(input),
      },
    }
  )
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
  readonly action: ActionDefinition
  readonly run: ActionRunRecord
  readonly signal: AbortSignal
  readonly logger: Logger
}) {
  return {
    run: {
      id: input.run.id,
      startedAt: input.run.startedAt ?? input.run.queuedAt,
      idempotencyKey: input.run.idempotencyKey,
    },
    logger: input.logger,
    // Params are stored as JSON (date/timestamp -> ISO string); handler types
    // promise `Date`, so re-hydrate them before the handler sees them.
    params: coerceActionParamsToTyped(
      input.action.params,
      input.run.params,
      input.runtime.sixb.objects.getValueTypesById()
    ),
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
      throw createSixbError(
        "internal.unexpected",
        `[SixbActionWorker] Action '${input.action.id}' does not accept a subject.`,
        { details: { actionId: input.action.id, runId: input.run.id } }
      )
    }
    return null
  }

  const subject = requireObjectSubject(input.run.subject, {
    actionId: input.action.id,
    runId: input.run.id,
  })
  const subjectObjectType = input.runtime.sixb.objects.resolveType(subject.objectTypeId)
  const actionAppliesToSubject = input.runtime.sixb.actions
    .listForType(subjectObjectType)
    .some((candidate) => candidate.id === input.action.id)
  if (!actionAppliesToSubject) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbActionWorker] Action '${input.action.id}' is not valid for object type '${subjectObjectType.id}'.`,
      { details: { actionId: input.action.id, runId: input.run.id } }
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
    row: targetRow,
  }
}

export function requireObjectSubject<
  TObjectType extends ObjectTypeWithPropertyTokens = ObjectTypeWithPropertyTokens,
>(
  subject: ActionSubject,
  input: { readonly actionId: string; readonly runId: string }
): ActionObjectSubject<TObjectType> {
  if (subject.kind !== "object") {
    throw createSixbError(
      "internal.unexpected",
      `[SixbActionWorker] Action '${input.actionId}' requires an object subject.`,
      { details: input }
    )
  }
  return subject as ActionObjectSubject<TObjectType>
}

export function requireObjectTarget(
  target: LoadedObjectTarget | null,
  input: { readonly actionId: string; readonly runId: string }
): LoadedObjectTarget {
  if (!target) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbActionWorker] Action '${input.actionId}' requires an object target.`,
      { details: input }
    )
  }
  return target
}
