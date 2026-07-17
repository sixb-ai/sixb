import { assertJsonValue, cloneJsonValue, type JsonValue } from "../json"
import { EditBatchError } from "./errors"
import type {
  EditBatch,
  EditBatchInput,
  EditBatchProducer,
  EditLinkClearOperation,
  EditLinkCreateOperation,
  EditLinkSetOperation,
  EditObjectCreateOperation,
  EditObjectProperties,
  EditObjectUpdateOperation,
  EditObjectUpsertOperation,
  EditOperation,
} from "./types"

export function normalizeEditBatch(input: EditBatchInput): EditBatch {
  if (Array.isArray(input)) {
    return {
      version: 1,
      operations: input.map((operation) => normalizeEditOperationInput(operation)),
    }
  }

  if (isEditBatch(input)) {
    return {
      version: 1,
      operations: input.operations.map((operation) => normalizeEditOperationInput(operation)),
    }
  }

  if (isEditBatchProducer(input)) {
    return normalizeEditBatch(input.toEditBatch())
  }

  return {
    version: 1,
    operations: [normalizeEditOperationInput(input as EditOperation)],
  }
}

export function normalizeEditOperationInput(input: EditOperation): EditOperation {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new EditBatchError("[Sixb] EditBatch operation must be an object.")
  }

  switch (input.kind) {
    case "object.create":
      return normalizeObjectCreateOperation(input)
    case "object.update":
      return normalizeObjectUpdateOperation(input)
    case "object.upsert":
      return normalizeObjectUpsertOperation(input)
    case "object.delete":
      return {
        kind: "object.delete",
        objectTypeId: assertNonEmptyString(input.objectTypeId, "operation.objectTypeId"),
        primaryId: assertNonEmptyString(input.primaryId, "operation.primaryId"),
      }
    case "link.create":
      return normalizeLinkCreateOperation(input)
    case "link.delete":
      return {
        kind: "link.delete",
        source: normalizeRef(input.source, "operation.source"),
        linkId: assertNonEmptyString(input.linkId, "operation.linkId"),
        target: normalizeRef(input.target, "operation.target"),
      }
    case "link.set":
      return normalizeLinkSetOperation(input)
    case "link.clear":
      return normalizeLinkClearOperation(input)
  }

  throw new EditBatchError(
    `[Sixb] Unknown EditBatch operation kind '${String((input as { kind?: unknown }).kind)}'.`
  )
}

function normalizeObjectCreateOperation(
  input: EditObjectCreateOperation
): EditObjectCreateOperation {
  return {
    kind: "object.create",
    objectTypeId: assertNonEmptyString(input.objectTypeId, "operation.objectTypeId"),
    primaryId: assertNonEmptyString(input.primaryId, "operation.primaryId"),
    properties: cloneProperties(input.properties, "operation.properties"),
  }
}

function normalizeObjectUpdateOperation(
  input: EditObjectUpdateOperation
): EditObjectUpdateOperation {
  return {
    kind: "object.update",
    objectTypeId: assertNonEmptyString(input.objectTypeId, "operation.objectTypeId"),
    primaryId: assertNonEmptyString(input.primaryId, "operation.primaryId"),
    properties: cloneProperties(input.properties, "operation.properties"),
  }
}

function normalizeObjectUpsertOperation(
  input: EditObjectUpsertOperation
): EditObjectUpsertOperation {
  return {
    kind: "object.upsert",
    objectTypeId: assertNonEmptyString(input.objectTypeId, "operation.objectTypeId"),
    primaryId: assertNonEmptyString(input.primaryId, "operation.primaryId"),
    properties: cloneProperties(input.properties, "operation.properties"),
  }
}

function normalizeLinkCreateOperation(input: EditLinkCreateOperation): EditLinkCreateOperation {
  return {
    kind: "link.create",
    source: normalizeRef(input.source, "operation.source"),
    linkId: assertNonEmptyString(input.linkId, "operation.linkId"),
    target: normalizeRef(input.target, "operation.target"),
    ...(input.properties !== undefined
      ? { properties: cloneProperties(input.properties, "operation.properties") }
      : {}),
  }
}

function normalizeLinkSetOperation(input: EditLinkSetOperation): EditLinkSetOperation {
  return {
    kind: "link.set",
    source: normalizeRef(input.source, "operation.source"),
    linkId: assertNonEmptyString(input.linkId, "operation.linkId"),
    target: normalizeRef(input.target, "operation.target"),
    ...(input.properties !== undefined
      ? { properties: cloneProperties(input.properties, "operation.properties") }
      : {}),
  }
}

function normalizeLinkClearOperation(input: EditLinkClearOperation): EditLinkClearOperation {
  return {
    kind: "link.clear",
    source: normalizeRef(input.source, "operation.source"),
    linkId: assertNonEmptyString(input.linkId, "operation.linkId"),
  }
}

function cloneProperties(value: EditObjectProperties, label: string): EditObjectProperties {
  assertJsonValue(value, label)
  return cloneJsonValue(value as JsonValue) as EditObjectProperties
}

function normalizeRef(value: { objectTypeId: string; primaryId: string }, label: string) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EditBatchError(`[Sixb] EditBatch ${label} must be an object ref.`)
  }
  return {
    objectTypeId: assertNonEmptyString(value.objectTypeId, `${label}.objectTypeId`),
    primaryId: assertNonEmptyString(value.primaryId, `${label}.primaryId`),
  }
}

function assertNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new EditBatchError(`[Sixb] EditBatch ${label} must be a non-empty string.`)
  }
  return value
}

function isEditBatch(input: unknown): input is EditBatch {
  return (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    (input as { version?: unknown }).version === 1 &&
    Array.isArray((input as { operations?: unknown }).operations)
  )
}

function isEditBatchProducer(input: unknown): input is EditBatchProducer {
  return (
    typeof input === "object" &&
    input !== null &&
    typeof (input as { toEditBatch?: unknown }).toEditBatch === "function"
  )
}
