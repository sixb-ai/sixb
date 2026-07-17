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
  EditLinkClearOperation,
  EditLinkSetOperation,
  EditObjectCreateOperation,
  EditObjectDeleteOperation,
  EditObjectHandle,
  EditObjectRef,
  EditObjectUpdateOperation,
  EditObjectUpsertOperation,
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

      upsert(properties: unknown) {
        const primaryProperty = getPrimaryProperty(objectType)
        const rawProperties = assertRecord(properties, `${objectType.id}.upsert.properties`)
        const primaryValue = rawProperties[primaryProperty.id]

        if (typeof primaryValue !== "string" || !primaryValue.trim()) {
          throw new EditBatchError(
            `[Sixb] EditBatch upsert '${objectType.id}' primary property '${primaryProperty.id}' must be a non-empty string.`
          )
        }

        const normalizedProperties = normalizeObjectEditProperties({
          objectType,
          properties: rawProperties,
          valueTypesById,
          path: `${objectType.id}.upsert`,
        })

        const operation: EditObjectUpsertOperation = {
          kind: "object.upsert",
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
          assertLinkTokenSource(ref, link)

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
          assertLinkTokenSource(ref, link)

          operations.push({
            kind: "link.delete",
            source: toPlainRef(ref),
            linkId: link.id,
            target: toPlainRef(target),
          })
        },
      },
      setLink: {
        value(
          link: { objectTypeId: string; id: string; link: ObjectLink },
          target: EditObjectRef,
          linkOptions?: { readonly properties?: Readonly<Record<string, unknown>> }
        ) {
          assertCardinalityOneLinkToken(ref, link, "setLink")
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

          const operation: EditLinkSetOperation = {
            kind: "link.set",
            source: toPlainRef(ref),
            linkId: link.id,
            target: toPlainRef(target),
            ...(properties !== undefined ? { properties } : {}),
          }
          operations.push(operation)
        },
      },
      clearLink: {
        value(link: { objectTypeId: string; id: string; link: ObjectLink }) {
          assertCardinalityOneLinkToken(ref, link, "clearLink")
          const operation: EditLinkClearOperation = {
            kind: "link.clear",
            source: toPlainRef(ref),
            linkId: link.id,
          }
          operations.push(operation)
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

function assertLinkTokenSource(
  source: EditObjectRef,
  link: { readonly objectTypeId: string; readonly id: string }
): void {
  if (source.objectTypeId !== link.objectTypeId) {
    throw new OntologyValidationError(
      `[Sixb] Link token ${link.objectTypeId}.${link.id} cannot be used with ${source.objectTypeId}`
    )
  }
}

function assertCardinalityOneLinkToken(
  source: EditObjectRef,
  link: { readonly objectTypeId: string; readonly id: string; readonly link: ObjectLink },
  operation: "setLink" | "clearLink"
): void {
  assertLinkTokenSource(source, link)
  if (link.link.cardinality !== "one") {
    throw new OntologyValidationError(
      `[Sixb] ${operation} requires cardinality 'one' link '${link.objectTypeId}.${link.id}'`
    )
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
