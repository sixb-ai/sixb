import { createHash } from "node:crypto"
import type { ObjectLink, ValueType } from "../ontology"
import { OntologyValidationError } from "../ontology/errors"
import type { ObjectTypeWithPropertyTokens } from "../ontology/tokens"
import { assertRequiredProperties } from "../ontology/validation"
import { EditBatchError } from "./errors"
import { normalizeEditBatch } from "./normalize"
import {
  assertPrimaryPropertyNotUpdated,
  getPrimaryProperty,
  normalizeLinkEditProperties,
  normalizeObjectEditProperties,
} from "./properties"
import type {
  EditBatch,
  EditObjectCreateOperation,
  EditObjectDeleteOperation,
  EditObjectHandle,
  EditObjectRef,
  EditObjectUpdateOperation,
  EditOperation,
  RecordEditsContext,
  RecordEditsHandler,
  RecordEditsOptions,
} from "./types"

export type { RecordEditsHandler, RecordEditsOptions } from "./types"

const EMPTY_VALUE_TYPES = new Map<string, ValueType>()

type RuntimeEditRecorder = {
  readonly objects: (objectType: ObjectTypeWithPropertyTokens) => unknown
  toEditBatch(): EditBatch
}

export async function recordEdits(
  options: RecordEditsOptions,
  handler: RecordEditsHandler
): Promise<EditBatch> {
  const recorder = createEditRecorder(options)
  await handler({ objects: recorder.objects } as RecordEditsContext)
  return recorder.toEditBatch()
}

function createEditRecorder(options: RecordEditsOptions): RuntimeEditRecorder {
  if (!options.runId.trim()) {
    throw new EditBatchError("[Sixb] recordEdits requires a non-empty runId.")
  }

  const operations: EditOperation[] = []
  const valueTypesById = options.valueTypesById ?? EMPTY_VALUE_TYPES

  function objects(objectType: ObjectTypeWithPropertyTokens) {
    return {
      byId(primaryId: string) {
        return createObjectHandle(objectType, createRef(objectType.id, primaryId))
      },

      create(properties: unknown) {
        const operationPath = String(operations.length)
        const primaryProperty = getPrimaryProperty(objectType)
        const rawProperties = assertRecord(properties, `${objectType.id}.create.properties`)
        const primaryValue =
          rawProperties[primaryProperty.id] ??
          generatePrimaryId({
            runId: options.runId,
            operationPath,
            objectTypeId: objectType.id,
          })

        if (typeof primaryValue !== "string" || !primaryValue.trim()) {
          throw new EditBatchError(
            `[Sixb] EditBatch create '${objectType.id}' primary property '${primaryProperty.id}' must be a non-empty string.`
          )
        }

        const normalizedProperties = normalizeObjectEditProperties({
          objectType,
          properties: {
            ...rawProperties,
            [primaryProperty.id]: primaryValue,
          },
          valueTypesById,
          path: `${objectType.id}.create`,
        })
        assertRequiredProperties(objectType, normalizedProperties)

        const operation: EditObjectCreateOperation = {
          kind: "object.create",
          objectTypeId: objectType.id,
          primaryId: primaryValue,
          properties: normalizedProperties,
        }
        operations.push(operation)
        return createObjectHandle(objectType, {
          objectTypeId: objectType.id,
          primaryId: primaryValue,
        })
      },
    }
  }

  function toEditBatch(): EditBatch {
    return normalizeEditBatch({
      version: 1,
      operations,
    })
  }

  function createObjectHandle(
    objectType: ObjectTypeWithPropertyTokens,
    ref: EditObjectRef
  ): EditObjectHandle<ObjectTypeWithPropertyTokens> {
    const handle = {
      objectTypeId: ref.objectTypeId,
      primaryId: ref.primaryId,
    }

    Object.defineProperties(handle, {
      objectType: {
        value: objectType,
      },
      update: {
        value(properties: Readonly<Record<string, unknown>>) {
          const normalizedProperties = normalizeObjectEditProperties({
            objectType,
            properties: assertRecord(properties, `${objectType.id}.update.properties`),
            valueTypesById,
            path: `${objectType.id}.update`,
          })
          assertPrimaryPropertyNotUpdated(objectType, normalizedProperties)

          const operation: EditObjectUpdateOperation = {
            kind: "object.update",
            objectTypeId: objectType.id,
            primaryId: ref.primaryId,
            properties: normalizedProperties,
          }
          operations.push(operation)
        },
      },
      delete: {
        value() {
          const operation: EditObjectDeleteOperation = {
            kind: "object.delete",
            objectTypeId: ref.objectTypeId,
            primaryId: ref.primaryId,
          }
          operations.push(operation)
        },
      },
      link: {
        value(
          link: { objectTypeId: string; id: string; link: ObjectLink },
          target: EditObjectRef,
          linkOptions?: { readonly properties?: Readonly<Record<string, unknown>> }
        ) {
          if (ref.objectTypeId !== link.objectTypeId) {
            throw new OntologyValidationError(
              `[Sixb] Link token ${link.objectTypeId}.${link.id} cannot be used with ${ref.objectTypeId}`
            )
          }

          const properties =
            linkOptions?.properties === undefined
              ? undefined
              : normalizeLinkEditProperties({
                  sourceObjectTypeId: ref.objectTypeId,
                  linkId: link.id,
                  linkDefinition: link.link,
                  properties: linkOptions.properties,
                  valueTypesById,
                })

          operations.push({
            kind: "link.create",
            source: toPlainRef(ref),
            linkId: link.id,
            target: toPlainRef(target),
            ...(properties !== undefined ? { properties } : {}),
          })
        },
      },
      unlink: {
        value(link: { objectTypeId: string; id: string; link: ObjectLink }, target: EditObjectRef) {
          if (ref.objectTypeId !== link.objectTypeId) {
            throw new OntologyValidationError(
              `[Sixb] Link token ${link.objectTypeId}.${link.id} cannot be used with ${ref.objectTypeId}`
            )
          }

          operations.push({
            kind: "link.delete",
            source: toPlainRef(ref),
            linkId: link.id,
            target: toPlainRef(target),
          })
        },
      },
    })

    return handle as EditObjectHandle<ObjectTypeWithPropertyTokens>
  }

  return {
    objects,
    toEditBatch,
  }
}

function createRef<TObjectTypeId extends string>(
  objectTypeId: TObjectTypeId,
  primaryId: string
): EditObjectRef<TObjectTypeId> {
  return {
    objectTypeId: assertNonEmptyString(objectTypeId, "objectTypeId") as TObjectTypeId,
    primaryId: assertNonEmptyString(primaryId, `${objectTypeId}.primaryId`),
  }
}

function generatePrimaryId(params: {
  readonly runId: string
  readonly operationPath: string
  readonly objectTypeId: string
}): string {
  const hash = createHash("sha256")
    .update(`${params.runId}:${params.operationPath}:${params.objectTypeId}`)
    .digest("hex")
    .slice(0, 24)
  return `edit_${hash}`
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EditBatchError(`[Sixb] EditBatch ${label} must be an object.`)
  }
  return value as Record<string, unknown>
}

function assertNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new EditBatchError(`[Sixb] EditBatch ${label} must be a non-empty string.`)
  }
  return value
}

function toPlainRef(ref: EditObjectRef): EditObjectRef {
  return {
    objectTypeId: ref.objectTypeId,
    primaryId: ref.primaryId,
  }
}
