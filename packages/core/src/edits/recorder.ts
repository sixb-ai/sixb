import { createHash } from "node:crypto"
import type { ObjectLink, ValueType } from "../ontology"
import { OntologyValidationError } from "../ontology/errors"
import type { ObjectTypeWithPropertyTokens } from "../ontology/tokens"
import { assertRequiredProperties } from "../ontology/validation"
import { EditBatchError } from "./errors"
import {
  assertPrimaryPropertyNotUpdated,
  getPrimaryProperty,
  normalizeEditablePropertyIds,
  normalizeLinkEditProperties,
  normalizeObjectEditProperties,
} from "./properties"
import type {
  EditBatch,
  EditObjectHandle,
  EditObjectProperties,
  EditObjectRef,
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

        operations.push({
          kind: "object.create",
          objectTypeId: objectType.id,
          primaryId: primaryValue,
          properties: withoutPrimaryProperty(normalizedProperties, primaryProperty.id),
        })
        return createObjectHandle(objectType, {
          objectTypeId: objectType.id,
          primaryId: primaryValue,
        })
      },
    }
  }

  function toEditBatch(): EditBatch {
    return { operations: [...operations] }
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
          // An empty patch resolves to a null override and commits as `unchanged`, so a handler
          // that built its update conditionally would report a successful run that wrote nothing.
          if (Object.keys(normalizedProperties).length === 0) {
            throw new EditBatchError(
              `[Sixb] EditBatch update '${objectType.id}:${ref.primaryId}' must set at least one property.`
            )
          }

          operations.push({
            kind: "object.update",
            objectTypeId: ref.objectTypeId,
            primaryId: ref.primaryId,
            properties: normalizedProperties,
          })
        },
      },
      unset: {
        value(...propertyIds: readonly unknown[]) {
          operations.push({
            kind: "object.unset",
            objectTypeId: ref.objectTypeId,
            primaryId: ref.primaryId,
            propertyIds: normalizeEditablePropertyIds({
              objectType,
              propertyIds,
              operation: "unset",
            }),
          })
        },
      },
      reset: {
        value(...propertyIds: readonly unknown[]) {
          operations.push({
            kind: "object.reset",
            objectTypeId: ref.objectTypeId,
            primaryId: ref.primaryId,
            propertyIds: normalizeEditablePropertyIds({
              objectType,
              propertyIds,
              operation: "reset",
            }),
          })
        },
      },
      delete: {
        value() {
          operations.push({
            kind: "object.delete",
            objectTypeId: ref.objectTypeId,
            primaryId: ref.primaryId,
          })
        },
      },
      restore: {
        value() {
          operations.push({
            kind: "object.restore",
            objectTypeId: ref.objectTypeId,
            primaryId: ref.primaryId,
          })
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
            kind: "link.upsert",
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
      resetLink: {
        value(link: { objectTypeId: string; id: string; link: ObjectLink }, target: EditObjectRef) {
          assertLinkTokenSource(ref, link)

          operations.push({
            kind: "link.reset",
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

/** Primary identity lives in the object ref; managed authority never stores it as a property. */
function withoutPrimaryProperty(
  properties: EditObjectProperties,
  primaryPropertyId: string
): EditObjectProperties {
  const { [primaryPropertyId]: _primary, ...rest } = properties
  return rest
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
