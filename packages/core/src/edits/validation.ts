import type { JsonValue } from "../json"
import type { ObjectLink, ValueType } from "../ontology"
import type { OntologyRegistry } from "../ontology/registry"
import type { ObjectTypeWithPropertyTokens } from "../ontology/tokens"
import {
  assertLinkTargetType,
  assertRequiredProperties,
  validateLinkProperties,
} from "../ontology/validation"
import type { ObjectLinkRow, ObjectRow, ObjectStorage } from "../storage/objects/types"
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
  EditBatchInput,
  EditCommitDiff,
  EditLinkCreateOperation,
  EditLinkDeleteOperation,
  EditObjectDeleteOperation,
  EditObjectRef,
  EditObjectUpdateOperation,
  EditOperation,
} from "./types"

export interface ValidateEditBatchInput {
  readonly projectId: string
  readonly ontology: Pick<
    OntologyRegistry,
    "resolveObjectType" | "getPrimaryPropertyId" | "getValueTypesById" | "isValidLinkTarget"
  >
  readonly storage: {
    readonly objects: Pick<ObjectStorage, "getByPrimaryIdBatch" | "listLinksBatch">
  }
  readonly batch: EditBatchInput
}

export interface ValidateEditBatchResult {
  readonly batch: EditBatch
  readonly diff: EditCommitDiff
}

type NormalizedEditContext = Pick<ValidateEditBatchInput, "ontology">

type ObjectState = {
  objectTypeId: string
  primaryId: string
  objectType: ObjectTypeWithPropertyTokens
  properties: Record<string, JsonValue>
  exists: boolean
  createdInBatch: boolean
  deleted: boolean
}

type ObjectDiffAccumulator = {
  objectTypeId: string
  primaryId: string
  operation: "create" | "update" | "delete"
  changedProperties: Set<string>
}

type LinkState = {
  row: ObjectLinkRow
  createdInBatch: boolean
}

type LinkDiffAccumulator = {
  operation: "create" | "update" | "delete"
  source: EditObjectRef
  linkId: string
  target: EditObjectRef
}

export async function validateEditBatch(
  input: ValidateEditBatchInput
): Promise<ValidateEditBatchResult> {
  const initialBatch = normalizeEditBatch(input.batch)
  const batch = normalizeEditBatchWithOntology(initialBatch, input)
  const existingObjects = await loadExistingObjects(input, batch.operations)
  const existingLinks = await loadExistingLinks(input, batch.operations)
  const result = analyzeEditBatch({
    ...input,
    batch,
    existingObjects,
    existingLinks,
  })

  return {
    batch,
    diff: result.diff,
  }
}

export async function deriveEditCommitDiff(input: ValidateEditBatchInput): Promise<EditCommitDiff> {
  return (await validateEditBatch(input)).diff
}

function normalizeEditBatchWithOntology(batch: EditBatch, ctx: NormalizedEditContext): EditBatch {
  return {
    version: 1,
    operations: batch.operations.map((operation) => normalizeOperationWithOntology(operation, ctx)),
  }
}

function normalizeOperationWithOntology(
  operation: EditOperation,
  ctx: NormalizedEditContext
): EditOperation {
  const valueTypesById = ctx.ontology.getValueTypesById()

  switch (operation.kind) {
    case "object.create": {
      const objectType = ctx.ontology.resolveObjectType(operation.objectTypeId)
      const primaryProperty = getPrimaryProperty(objectType)
      const properties = normalizeObjectEditProperties({
        objectType,
        properties: operation.properties,
        valueTypesById,
        path: `${objectType.id}.create`,
      })
      assertRequiredProperties(objectType, properties)
      assertPrimaryPropertyMatchesRef(
        objectType,
        primaryProperty.id,
        operation.primaryId,
        properties
      )
      return {
        ...operation,
        properties,
      }
    }
    case "object.update": {
      const objectType = ctx.ontology.resolveObjectType(operation.objectTypeId)
      if (Object.keys(operation.properties).length === 0) {
        throw new EditBatchError(
          `[Sixb] EditBatch update '${objectType.id}:${operation.primaryId}' must set at least one property.`
        )
      }
      const properties = normalizeObjectEditProperties({
        objectType,
        properties: operation.properties,
        valueTypesById,
        path: `${objectType.id}.set`,
      })
      assertPrimaryPropertyNotUpdated(objectType, properties)
      return {
        ...operation,
        properties,
      }
    }
    case "object.delete":
      ctx.ontology.resolveObjectType(operation.objectTypeId)
      return operation
    case "link.create": {
      const sourceObjectType = ctx.ontology.resolveObjectType(operation.source.objectTypeId)
      const linkDefinition = requireLinkDefinition(sourceObjectType, operation.linkId)
      assertLinkTargetType(
        sourceObjectType.id,
        operation.linkId,
        linkDefinition,
        operation.target.objectTypeId,
        (expected, actual) => ctx.ontology.isValidLinkTarget(expected, actual)
      )
      const properties =
        operation.properties === undefined
          ? undefined
          : normalizeLinkEditProperties({
              sourceObjectTypeId: sourceObjectType.id,
              linkId: operation.linkId,
              linkDefinition,
              properties: operation.properties,
              valueTypesById,
            })
      return {
        ...operation,
        ...(properties !== undefined ? { properties } : {}),
      }
    }
    case "link.delete": {
      const sourceObjectType = ctx.ontology.resolveObjectType(operation.source.objectTypeId)
      const linkDefinition = requireLinkDefinition(sourceObjectType, operation.linkId)
      assertLinkTargetType(
        sourceObjectType.id,
        operation.linkId,
        linkDefinition,
        operation.target.objectTypeId,
        (expected, actual) => ctx.ontology.isValidLinkTarget(expected, actual)
      )
      return operation
    }
  }
}

async function loadExistingObjects(
  input: ValidateEditBatchInput,
  operations: readonly EditOperation[]
): Promise<Map<string, ObjectRow>> {
  const items = new Map<string, { objectTypeId: string; primaryId: string }>()

  for (const operation of operations) {
    switch (operation.kind) {
      case "object.create":
      case "object.update":
      case "object.delete":
        items.set(objectKey(operation.objectTypeId, operation.primaryId), {
          objectTypeId: operation.objectTypeId,
          primaryId: operation.primaryId,
        })
        break
      case "link.create":
      case "link.delete":
        items.set(objectKey(operation.source.objectTypeId, operation.source.primaryId), {
          objectTypeId: operation.source.objectTypeId,
          primaryId: operation.source.primaryId,
        })
        items.set(objectKey(operation.target.objectTypeId, operation.target.primaryId), {
          objectTypeId: operation.target.objectTypeId,
          primaryId: operation.target.primaryId,
        })
        break
    }
  }

  return input.storage.objects.getByPrimaryIdBatch({
    projectId: input.projectId,
    items: [...items.values()],
  })
}

async function loadExistingLinks(
  input: ValidateEditBatchInput,
  operations: readonly EditOperation[]
): Promise<Map<string, ObjectLinkRow[]>> {
  const items = new Map<string, { objectTypeId: string; objectId: string; linkId: string }>()

  for (const operation of operations) {
    if (operation.kind !== "link.create" && operation.kind !== "link.delete") continue
    items.set(
      sourceLinkKey(operation.source.objectTypeId, operation.source.primaryId, operation.linkId),
      {
        objectTypeId: operation.source.objectTypeId,
        objectId: operation.source.primaryId,
        linkId: operation.linkId,
      }
    )
  }

  return input.storage.objects.listLinksBatch({
    projectId: input.projectId,
    items: [...items.values()],
  })
}

function analyzeEditBatch(
  input: ValidateEditBatchInput & {
    readonly existingObjects: Map<string, ObjectRow>
    readonly existingLinks: Map<string, ObjectLinkRow[]>
  }
): { diff: EditCommitDiff } {
  const valueTypesById = input.ontology.getValueTypesById()
  const objectStates = seedObjectStates(input)
  const linkStates = seedLinkStates(input.existingLinks)
  const objectDiffs = new Map<string, ObjectDiffAccumulator>()
  const linkDiffs = new Map<string, LinkDiffAccumulator>()

  for (const operation of normalizeEditBatch(input.batch).operations) {
    switch (operation.kind) {
      case "object.create":
        applyObjectCreate(input, operation, objectStates, objectDiffs)
        break
      case "object.update":
        applyObjectUpdate(input, operation, objectStates, objectDiffs, valueTypesById)
        break
      case "object.delete":
        applyObjectDelete(input, operation, objectStates, objectDiffs)
        break
      case "link.create":
        applyLinkCreate(input, operation, objectStates, linkStates, linkDiffs, valueTypesById)
        break
      case "link.delete":
        applyLinkDelete(input, operation, objectStates, linkStates, linkDiffs)
        break
    }
  }

  return {
    diff: {
      objects: [...objectDiffs.values()]
        .filter((entry) => entry.operation !== "update" || entry.changedProperties.size > 0)
        .map((entry) => ({
          objectTypeId: entry.objectTypeId,
          primaryId: entry.primaryId,
          operation: entry.operation,
          changedProperties: [...entry.changedProperties].sort(compareStrings),
        }))
        .sort(compareObjectDiffs),
      links: [...linkDiffs.values()].sort(compareLinkDiffs),
    },
  }
}

function seedObjectStates(input: {
  readonly ontology: ValidateEditBatchInput["ontology"]
  readonly existingObjects: Map<string, ObjectRow>
}): Map<string, ObjectState> {
  const states = new Map<string, ObjectState>()
  for (const row of input.existingObjects.values()) {
    const objectType = input.ontology.resolveObjectType(row.objectTypeId)
    states.set(objectKey(row.objectTypeId, row.primaryId), {
      objectTypeId: row.objectTypeId,
      primaryId: row.primaryId,
      objectType,
      properties: { ...row.properties } as Record<string, JsonValue>,
      exists: true,
      createdInBatch: false,
      deleted: false,
    })
  }
  return states
}

function seedLinkStates(existingLinks: Map<string, ObjectLinkRow[]>): Map<string, LinkState> {
  const states = new Map<string, LinkState>()
  for (const links of existingLinks.values()) {
    for (const row of links) {
      states.set(
        linkKey(row.sourceTypeId, row.sourceId, row.linkId, row.targetTypeId, row.targetId),
        {
          row,
          createdInBatch: false,
        }
      )
    }
  }
  return states
}

function applyObjectCreate(
  input: ValidateEditBatchInput,
  operation: Extract<EditOperation, { kind: "object.create" }>,
  states: Map<string, ObjectState>,
  diffs: Map<string, ObjectDiffAccumulator>
): void {
  const key = objectKey(operation.objectTypeId, operation.primaryId)
  const existing = states.get(key)
  if (existing && (!existing.createdInBatch || (existing.exists && !existing.deleted))) {
    throw new EditBatchError(
      `[Sixb] EditBatch cannot create existing object '${operation.objectTypeId}:${operation.primaryId}'.`
    )
  }

  const objectType = input.ontology.resolveObjectType(operation.objectTypeId)
  states.set(key, {
    objectTypeId: operation.objectTypeId,
    primaryId: operation.primaryId,
    objectType,
    properties: { ...operation.properties },
    exists: true,
    createdInBatch: true,
    deleted: false,
  })
  diffs.set(key, {
    objectTypeId: operation.objectTypeId,
    primaryId: operation.primaryId,
    operation: "create",
    changedProperties: new Set(Object.keys(operation.properties)),
  })
}

function applyObjectUpdate(
  input: ValidateEditBatchInput,
  operation: EditObjectUpdateOperation,
  states: Map<string, ObjectState>,
  diffs: Map<string, ObjectDiffAccumulator>,
  valueTypesById: ReadonlyMap<string, ValueType>
): void {
  const state = requireActiveObjectState(input, states, {
    objectTypeId: operation.objectTypeId,
    primaryId: operation.primaryId,
  })
  const diff = ensureObjectDiff(diffs, state, "update")

  for (const [propertyId, value] of Object.entries(operation.properties)) {
    const property = state.objectType.properties.find((candidate) => candidate.id === propertyId)
    if (!property) continue
    const previous = normalizeExistingObjectProperty({
      state,
      propertyId,
      valueTypesById,
    })
    const normalized = normalizeObjectEditProperties({
      objectType: state.objectType,
      properties: { [propertyId]: value },
      valueTypesById,
      path: `${state.objectType.id}.set`,
    })[propertyId]
    if (!jsonValuesEqual(previous, normalized)) {
      diff.changedProperties.add(propertyId)
    }
    state.properties[propertyId] = normalized
  }

  assertRequiredProperties(state.objectType, state.properties)
}

function applyObjectDelete(
  input: ValidateEditBatchInput,
  operation: EditObjectDeleteOperation,
  states: Map<string, ObjectState>,
  diffs: Map<string, ObjectDiffAccumulator>
): void {
  const state = requireActiveObjectState(input, states, {
    objectTypeId: operation.objectTypeId,
    primaryId: operation.primaryId,
  })
  const key = objectKey(operation.objectTypeId, operation.primaryId)
  state.exists = false
  state.deleted = true

  if (state.createdInBatch) {
    diffs.delete(key)
    return
  }

  diffs.set(key, {
    objectTypeId: operation.objectTypeId,
    primaryId: operation.primaryId,
    operation: "delete",
    changedProperties: new Set(),
  })
}

function applyLinkCreate(
  input: ValidateEditBatchInput,
  operation: EditLinkCreateOperation,
  objectStates: Map<string, ObjectState>,
  linkStates: Map<string, LinkState>,
  diffs: Map<string, LinkDiffAccumulator>,
  valueTypesById: ReadonlyMap<string, ValueType>
): void {
  requireActiveObjectState(input, objectStates, operation.source)
  requireActiveObjectState(input, objectStates, operation.target)

  const sourceObjectType = input.ontology.resolveObjectType(operation.source.objectTypeId)
  const linkDefinition = requireLinkDefinition(sourceObjectType, operation.linkId)
  const key = linkKey(
    operation.source.objectTypeId,
    operation.source.primaryId,
    operation.linkId,
    operation.target.objectTypeId,
    operation.target.primaryId
  )
  const existing = linkStates.get(key)
  const currentProperties = existing?.row.properties

  validateLinkProperties(
    sourceObjectType,
    linkDefinition,
    operation.properties,
    currentProperties,
    valueTypesById
  )
  assertLinkCardinality(operation, linkDefinition, linkStates)

  const nextProperties = {
    ...(currentProperties ?? {}),
    ...(operation.properties ?? {}),
  }
  linkStates.set(key, {
    row: {
      projectId: input.projectId,
      sourceTypeId: operation.source.objectTypeId,
      sourceId: operation.source.primaryId,
      linkId: operation.linkId,
      targetTypeId: operation.target.objectTypeId,
      targetId: operation.target.primaryId,
      properties: Object.keys(nextProperties).length > 0 ? nextProperties : undefined,
      createdAt: existing?.row.createdAt ?? new Date(0),
      updatedAt: new Date(0),
    },
    createdInBatch: existing?.createdInBatch ?? !existing,
  })

  const diffKey = key
  const hasPropertyChanges =
    operation.properties !== undefined && !jsonValuesEqual(currentProperties ?? {}, nextProperties)
  if (!existing) {
    diffs.set(diffKey, {
      operation: "create",
      source: operation.source,
      linkId: operation.linkId,
      target: operation.target,
    })
    return
  }

  if (hasPropertyChanges) {
    const previousDiff = diffs.get(diffKey)
    diffs.set(diffKey, {
      operation: previousDiff?.operation === "create" ? "create" : "update",
      source: operation.source,
      linkId: operation.linkId,
      target: operation.target,
    })
  }
}

function applyLinkDelete(
  input: ValidateEditBatchInput,
  operation: EditLinkDeleteOperation,
  objectStates: Map<string, ObjectState>,
  linkStates: Map<string, LinkState>,
  diffs: Map<string, LinkDiffAccumulator>
): void {
  requireActiveObjectState(input, objectStates, operation.source)
  requireActiveObjectState(input, objectStates, operation.target)

  const key = linkKey(
    operation.source.objectTypeId,
    operation.source.primaryId,
    operation.linkId,
    operation.target.objectTypeId,
    operation.target.primaryId
  )
  const existing = linkStates.get(key)
  if (!existing) {
    return
  }

  linkStates.delete(key)
  if (existing.createdInBatch) {
    diffs.delete(key)
    return
  }

  diffs.set(key, {
    operation: "delete",
    source: operation.source,
    linkId: operation.linkId,
    target: operation.target,
  })
}

function requireActiveObjectState(
  input: ValidateEditBatchInput,
  states: Map<string, ObjectState>,
  ref: EditObjectRef
): ObjectState {
  const key = objectKey(ref.objectTypeId, ref.primaryId)
  const state = states.get(key)
  if (!state || !state.exists || state.deleted) {
    throw new EditBatchError(
      `[Sixb] EditBatch references missing object '${ref.objectTypeId}:${ref.primaryId}'.`
    )
  }

  input.ontology.resolveObjectType(ref.objectTypeId)
  return state
}

function ensureObjectDiff(
  diffs: Map<string, ObjectDiffAccumulator>,
  state: ObjectState,
  operation: "update"
): ObjectDiffAccumulator {
  const key = objectKey(state.objectTypeId, state.primaryId)
  const existing = diffs.get(key)
  if (existing) {
    return existing
  }

  const diff: ObjectDiffAccumulator = {
    objectTypeId: state.objectTypeId,
    primaryId: state.primaryId,
    operation,
    changedProperties: new Set(),
  }
  diffs.set(key, diff)
  return diff
}

function assertLinkCardinality(
  operation: EditLinkCreateOperation,
  linkDefinition: ObjectLink,
  linkStates: Map<string, LinkState>
): void {
  if (linkDefinition.cardinality !== "one") return

  const sourceKey = sourceLinkKey(
    operation.source.objectTypeId,
    operation.source.primaryId,
    operation.linkId
  )
  for (const state of linkStates.values()) {
    const candidate = state.row
    if (sourceLinkKey(candidate.sourceTypeId, candidate.sourceId, candidate.linkId) !== sourceKey) {
      continue
    }
    if (
      candidate.targetTypeId === operation.target.objectTypeId &&
      candidate.targetId === operation.target.primaryId
    ) {
      continue
    }
    throw new EditBatchError(
      `[Sixb] Link ${operation.source.objectTypeId}.${operation.linkId} has cardinality 'one'` +
        ` and already points to ${candidate.targetTypeId}:${candidate.targetId}`
    )
  }
}

function normalizeExistingObjectProperty(params: {
  readonly state: ObjectState
  readonly propertyId: string
  readonly valueTypesById: ReadonlyMap<string, ValueType>
}): JsonValue | undefined {
  const { state, propertyId, valueTypesById } = params
  const previous = state.properties[propertyId]
  if (previous === undefined) {
    return undefined
  }
  const normalized = normalizeObjectEditProperties({
    objectType: state.objectType,
    properties: { [propertyId]: previous },
    valueTypesById,
    path: `${state.objectType.id}.existing`,
  })
  return normalized[propertyId]
}

function assertPrimaryPropertyMatchesRef(
  objectType: ObjectTypeWithPropertyTokens,
  primaryPropertyId: string,
  primaryId: string,
  properties: Record<string, JsonValue>
): void {
  if (properties[primaryPropertyId] !== primaryId) {
    throw new EditBatchError(
      `[Sixb] EditBatch create '${objectType.id}:${primaryId}' must include matching primary property '${primaryPropertyId}'.`
    )
  }
}

function requireLinkDefinition(
  objectType: ObjectTypeWithPropertyTokens,
  linkId: string
): ObjectLink {
  const linkDefinition = objectType.links.find((link) => link.id === linkId)
  if (!linkDefinition) {
    throw new EditBatchError(`[Sixb] Unknown link '${objectType.id}.${linkId}'.`)
  }
  return linkDefinition
}

function objectKey(objectTypeId: string, primaryId: string): string {
  return JSON.stringify([objectTypeId, primaryId])
}

function sourceLinkKey(objectTypeId: string, primaryId: string, linkId: string): string {
  return JSON.stringify([objectTypeId, primaryId, linkId])
}

function linkKey(
  sourceObjectTypeId: string,
  sourcePrimaryId: string,
  linkId: string,
  targetObjectTypeId: string,
  targetPrimaryId: string
): string {
  return JSON.stringify([
    sourceObjectTypeId,
    sourcePrimaryId,
    linkId,
    targetObjectTypeId,
    targetPrimaryId,
  ])
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  return stableJsonStringify(left) === stableJsonStringify(right)
}

function stableJsonStringify(value: unknown): string {
  if (value === undefined) return "undefined"
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(",")}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJsonStringify(entry)}`)
    .join(",")}}`
}

function compareObjectDiffs(
  left: EditCommitDiff["objects"][number],
  right: EditCommitDiff["objects"][number]
) {
  return (
    compareStrings(left.objectTypeId, right.objectTypeId) ||
    compareStrings(left.primaryId, right.primaryId) ||
    compareStrings(left.operation, right.operation)
  )
}

function compareLinkDiffs(
  left: EditCommitDiff["links"][number],
  right: EditCommitDiff["links"][number]
) {
  return (
    compareStrings(left.source.objectTypeId, right.source.objectTypeId) ||
    compareStrings(left.source.primaryId, right.source.primaryId) ||
    compareStrings(left.linkId, right.linkId) ||
    compareStrings(left.target.objectTypeId, right.target.objectTypeId) ||
    compareStrings(left.target.primaryId, right.target.primaryId) ||
    compareStrings(left.operation, right.operation)
  )
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}
