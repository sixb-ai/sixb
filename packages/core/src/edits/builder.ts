import { createHash } from "node:crypto"
import type { ObjectLink, Property, ValueType } from "../ontology"
import { OntologyValidationError } from "../ontology/errors"
import type { ObjectTypeWithPropertyTokens, PropertyToken } from "../ontology/tokens"
import { assertRequiredProperties } from "../ontology/validation"
import { EditBatchError } from "./errors"
import { normalizeEditBatch } from "./normalize"
import {
  assertPrimaryPropertyNotUpdated,
  cloneJsonProperties,
  getPrimaryProperty,
  normalizeLinkEditProperties,
  normalizeObjectEditProperties,
  normalizePropertyTokenEdit,
} from "./properties"
import type {
  CreateEditBuilderOptions,
  EditBatch,
  EditBuilder,
  EditLinkCreateOperation,
  EditLinkDeleteOperation,
  EditObjectCreateOperation,
  EditObjectDeleteOperation,
  EditObjectHandle,
  EditObjectRef,
  EditObjectUpdateOperation,
  EditOperation,
  EditOperationHandle,
} from "./types"

const EMPTY_VALUE_TYPES = new Map<string, ValueType>()

export function createEditBuilder<TValueTypes extends readonly ValueType[] = []>(
  options: CreateEditBuilderOptions
): EditBuilder<TValueTypes> {
  if (!options.runId.trim()) {
    throw new EditBatchError("[Sixb] createEditBuilder requires a non-empty runId.")
  }

  const operations: EditOperation[] = []
  const valueTypesById = options.valueTypesById ?? EMPTY_VALUE_TYPES

  const builder = {
    object(objectType: ObjectTypeWithPropertyTokens, primaryId: string) {
      return createObjectHandle(objectType, createRef(objectType.id, primaryId))
    },

    ref(objectType: { id: string }, primaryId: string) {
      return createRef(objectType.id, primaryId)
    },

    create(objectType: ObjectTypeWithPropertyTokens, properties: unknown) {
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
      return createObjectHandle(
        objectType,
        { objectTypeId: objectType.id, primaryId: primaryValue },
        operation
      )
    },

    set(
      first: unknown,
      second: unknown,
      third?: unknown
    ): EditOperationHandle<EditOperation, TValueTypes> {
      if (isEditObjectHandle(first) && isPlainRecord(second)) {
        return builder.set(first.objectType, first.primaryId, second)
      }

      if (isObjectType(first) && typeof second === "string") {
        const objectType = first
        const primaryId = second
        const properties = normalizeObjectEditProperties({
          objectType,
          properties: assertRecord(third, `${objectType.id}.set.properties`),
          valueTypesById,
          path: `${objectType.id}.set`,
        })
        assertPrimaryPropertyNotUpdated(objectType, properties)

        const operation: EditObjectUpdateOperation = {
          kind: "object.update",
          objectTypeId: objectType.id,
          primaryId: assertNonEmptyString(primaryId, `${objectType.id}.primaryId`),
          properties,
        }
        operations.push(operation)
        return createHandle(operation)
      }

      if (isEditRef(first) && isPropertyToken(second)) {
        if (first.objectTypeId !== second.objectTypeId) {
          throw new OntologyValidationError(
            `[Sixb] Property token ${second.objectTypeId}.${second.id} cannot be used with ${first.objectTypeId}`
          )
        }

        const properties = normalizePropertyTokenEdit({
          ref: first,
          property: second,
          value: third,
          valueTypesById,
        })
        const operation: EditObjectUpdateOperation = {
          kind: "object.update",
          objectTypeId: first.objectTypeId,
          primaryId: first.primaryId,
          properties,
        }
        operations.push(operation)
        return createHandle(operation)
      }

      if (isEditRef(first) && isPlainRecord(second)) {
        const operation: EditObjectUpdateOperation = {
          kind: "object.update",
          objectTypeId: first.objectTypeId,
          primaryId: first.primaryId,
          properties: cloneJsonProperties(second, `${first.objectTypeId}.set.properties`),
        }
        operations.push(operation)
        return createHandle(operation)
      }

      throw new EditBatchError("[Sixb] Invalid edit.set(...) arguments.")
    },

    delete(first: unknown, second?: unknown) {
      const ref =
        isObjectType(first) && typeof second === "string"
          ? createRef(first.id, second)
          : isEditRef(first)
            ? first
            : null

      if (!ref) {
        throw new EditBatchError("[Sixb] Invalid edit.delete(...) arguments.")
      }

      const operation: EditObjectDeleteOperation = {
        kind: "object.delete",
        objectTypeId: ref.objectTypeId,
        primaryId: ref.primaryId,
      }
      operations.push(operation)
      return createHandle(operation)
    },

    link(
      source: EditObjectRef,
      link: { objectTypeId: string; id: string; link: ObjectLink },
      target: EditObjectRef,
      linkOptions?: { readonly properties?: Readonly<Record<string, unknown>> }
    ) {
      if (source.objectTypeId !== link.objectTypeId) {
        throw new OntologyValidationError(
          `[Sixb] Link token ${link.objectTypeId}.${link.id} cannot be used with ${source.objectTypeId}`
        )
      }

      const properties =
        linkOptions?.properties === undefined
          ? undefined
          : normalizeLinkEditProperties({
              sourceObjectTypeId: source.objectTypeId,
              linkId: link.id,
              linkDefinition: link.link,
              properties: linkOptions.properties,
              valueTypesById,
            })

      const operation: EditLinkCreateOperation = {
        kind: "link.create",
        source: toPlainRef(source),
        linkId: link.id,
        target: toPlainRef(target),
        ...(properties !== undefined ? { properties } : {}),
      }
      operations.push(operation)
      return createHandle(operation)
    },

    unlink(
      source: EditObjectRef,
      link: { objectTypeId: string; id: string; link: ObjectLink },
      target: EditObjectRef
    ) {
      if (source.objectTypeId !== link.objectTypeId) {
        throw new OntologyValidationError(
          `[Sixb] Link token ${link.objectTypeId}.${link.id} cannot be used with ${source.objectTypeId}`
        )
      }

      const operation: EditLinkDeleteOperation = {
        kind: "link.delete",
        source: toPlainRef(source),
        linkId: link.id,
        target: toPlainRef(target),
      }
      operations.push(operation)
      return createHandle(operation)
    },

    toEditBatch(): EditBatch {
      return normalizeEditBatch({
        version: 1,
        operations,
      })
    },
  }

  function createHandle(
    operation: EditOperation,
    ref?: EditObjectRef
  ): EditOperationHandle<EditOperation, TValueTypes> {
    return Object.assign({}, builder, ref ?? {}, {
      operation,
      toEditOperation: () => operation,
      toEditBatch: () => builder.toEditBatch(),
    }) as unknown as EditOperationHandle<EditOperation, TValueTypes>
  }

  function createObjectHandle(
    objectType: ObjectTypeWithPropertyTokens,
    ref: EditObjectRef,
    operation?: EditObjectCreateOperation
  ): EditObjectHandle<ObjectTypeWithPropertyTokens, TValueTypes> {
    const handle = {
      objectTypeId: ref.objectTypeId,
      primaryId: ref.primaryId,
    }

    Object.defineProperties(handle, {
      objectType: {
        value: objectType,
      },
      set: {
        value(properties: Readonly<Record<string, unknown>>) {
          return builder.set(objectType, ref.primaryId, properties)
        },
      },
      delete: {
        value() {
          return builder.delete(ref)
        },
      },
      link: {
        value(
          link: { objectTypeId: string; id: string; link: ObjectLink },
          target: EditObjectRef,
          linkOptions?: { readonly properties?: Readonly<Record<string, unknown>> }
        ) {
          return builder.link(ref, link, target, linkOptions)
        },
      },
      unlink: {
        value(link: { objectTypeId: string; id: string; link: ObjectLink }, target: EditObjectRef) {
          return builder.unlink(ref, link, target)
        },
      },
      toEditBatch: {
        value: () => builder.toEditBatch(),
      },
      ...(operation
        ? {
            operation: {
              value: operation,
            },
            toEditOperation: {
              value: () => operation,
            },
          }
        : {}),
    })

    return handle as unknown as EditObjectHandle<ObjectTypeWithPropertyTokens, TValueTypes>
  }

  return builder as unknown as EditBuilder<TValueTypes>
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

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function assertNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new EditBatchError(`[Sixb] EditBatch ${label} must be a non-empty string.`)
  }
  return value
}

function isObjectType(value: unknown): value is ObjectTypeWithPropertyTokens {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    Array.isArray((value as { properties?: unknown }).properties)
  )
}

function isEditRef(value: unknown): value is EditObjectRef {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { objectTypeId?: unknown }).objectTypeId === "string" &&
    typeof (value as { primaryId?: unknown }).primaryId === "string"
  )
}

function isEditObjectHandle(value: unknown): value is EditObjectHandle {
  return isEditRef(value) && isObjectType((value as { objectType?: unknown }).objectType)
}

function toPlainRef(ref: EditObjectRef): EditObjectRef {
  return {
    objectTypeId: ref.objectTypeId,
    primaryId: ref.primaryId,
  }
}

function isPropertyToken(value: unknown): value is PropertyToken<string, string, Property> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { objectTypeId?: unknown }).objectTypeId === "string" &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { property?: unknown }).property === "object"
  )
}
