import { compareStrings, type JsonValue, jsonValuesEqual } from "../json"
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
  EditObjectUpsertOperation,
  EditOperation,
} from "./types"

export interface ValidateEditBatchInput {
  readonly projectId: string
  readonly ontology: Pick<
    OntologyRegistry,
    "resolveObjectType" | "getPrimaryPropertyId" | "getValueTypesById" | "isValidLinkTarget"
  >
  readonly storage: {
    readonly objects: Pick<
      ObjectStorage,
      "getByPrimaryIdBatch" | "listLinksBatch" | "listIncidentLinksBatch"
    >
  }
  readonly batch: EditBatchInput
}

export interface ValidateEditBatchResult {
  readonly batch: EditBatch
  readonly diff: EditCommitDiff
}

export interface EditBatchLoadRequests {
  readonly objects: readonly { objectTypeId: string; primaryId: string }[]
  readonly sourceLinks: readonly { objectTypeId: string; objectId: string; linkId: string }[]
  readonly incidentLinks: readonly { objectTypeId: string; objectId: string }[]
}

export interface EditBatchLoadedState {
  readonly existingObjects: Map<string, ObjectRow>
  readonly existingLinks: Map<string, ObjectLinkRow[]>
}

export interface EditObjectUpsertPlan {
  readonly objectTypeId: string
  readonly primaryId: string
  readonly properties: Readonly<Record<string, JsonValue>>
  readonly previousProperties?: Readonly<Record<string, JsonValue>>
  readonly operation: "create" | "update"
}

export interface EditObjectDeletePlan {
  readonly objectTypeId: string
  readonly primaryId: string
  readonly previousProperties?: Readonly<Record<string, JsonValue>>
}

export interface EditLinkUpsertPlan {
  readonly source: EditObjectRef
  readonly linkId: string
  readonly target: EditObjectRef
  readonly properties?: Readonly<Record<string, JsonValue>>
  readonly previousProperties?: Readonly<Record<string, JsonValue>>
  readonly operation: "create" | "update"
}

export interface EditLinkDeletePlan {
  readonly source: EditObjectRef
  readonly linkId: string
  readonly target: EditObjectRef
  readonly previousProperties?: Readonly<Record<string, JsonValue>>
}

export interface EditCommitPlan {
  readonly batch: EditBatch
  readonly diff: EditCommitDiff
  readonly objects: {
    readonly upserts: readonly EditObjectUpsertPlan[]
    readonly deletes: readonly EditObjectDeletePlan[]
  }
  readonly links: {
    readonly upserts: readonly EditLinkUpsertPlan[]
    readonly deletes: readonly EditLinkDeletePlan[]
  }
}

type NormalizedEditContext = Pick<ValidateEditBatchInput, "ontology">

/**
 * Working state for a single object during batch analysis.
 *
 * `baseline*` captures the row as loaded from storage (the committed state the diff is computed
 * against); the `present`/`properties` pair tracks the live in-batch state after applying each
 * operation in order. The diff operation is *derived* from baseline-vs-present at the end of the
 * pass, never mutated per-operation — so a `delete` followed by a `create` of the same key nets to
 * an `update` (the row still exists) instead of corrupting into a `create` of a live row.
 */
type ObjectState = {
  objectTypeId: string
  primaryId: string
  objectType: ObjectTypeWithPropertyTokens
  baselineExists: boolean
  baselineProperties?: Record<string, JsonValue>
  present: boolean
  properties: Record<string, JsonValue>
}

/**
 * Working state for a single link during batch analysis. Mirrors {@link ObjectState}: the diff
 * operation is derived from `baselineExists` vs `present` at the end of the pass.
 */
type LinkState = {
  source: EditObjectRef
  linkId: string
  target: EditObjectRef
  baselineExists: boolean
  baselineProperties?: Record<string, JsonValue>
  present: boolean
  properties?: Record<string, JsonValue>
}

/**
 * Link states plus auxiliary indexes maintained as links transition present/absent.
 *
 * - `bySourceLink` answers cardinality questions ("which present links exist for this
 *   source+linkId?") in O(degree) instead of scanning every link per operation.
 * - `byObject` answers incident questions ("which present links touch this object as source or
 *   target?") for `object.delete` cascades, again in O(degree).
 *
 * Both indexes only ever contain keys of *present* links.
 */
type LinkStateIndex = {
  byKey: Map<string, LinkState>
  bySourceLink: Map<string, Set<string>>
  byObject: Map<string, Set<string>>
}

type EditAnalysisInput = Omit<ValidateEditBatchInput, "batch" | "storage"> & {
  readonly batch: EditBatch
  readonly existingObjects: Map<string, ObjectRow>
  readonly existingLinks: Map<string, ObjectLinkRow[]>
}

export async function validateEditBatch(
  input: ValidateEditBatchInput
): Promise<ValidateEditBatchResult> {
  const result = await planEditBatch(input)

  return {
    batch: result.batch,
    diff: result.diff,
  }
}

export async function deriveEditCommitDiff(input: ValidateEditBatchInput): Promise<EditCommitDiff> {
  return (await planEditBatch(input)).diff
}

export async function planEditBatch(input: ValidateEditBatchInput): Promise<EditCommitPlan> {
  const batch = normalizeEditBatchWithOntology(normalizeEditBatch(input.batch), input)
  const loadedState = await loadEditBatchState({ ...input, batch })

  return planEditBatchFromLoadedState({
    ...input,
    batch,
    ...loadedState,
  })
}

export async function loadEditBatchState(
  input: ValidateEditBatchInput
): Promise<EditBatchLoadedState> {
  const requests = collectEditBatchLoadRequests(input.batch)
  const existingObjects = await input.storage.objects.getByPrimaryIdBatch({
    projectId: input.projectId,
    items: requests.objects,
  })
  const existingLinks = await input.storage.objects.listLinksBatch({
    projectId: input.projectId,
    items: requests.sourceLinks,
  })

  // `listLinksBatch` only returns outgoing links (by source+linkId); a delete cascades to links in
  // both directions, so load those in one batched read — fewer round trips keep the serializable
  // commit transaction's lock hold short. Bucket key is arbitrary: `seedLinkIndex` re-keys by link.
  const incidentLinks = await input.storage.objects.listIncidentLinksBatch({
    projectId: input.projectId,
    items: requests.incidentLinks,
  })
  if (incidentLinks.length > 0) {
    existingLinks.set("incident", [...incidentLinks])
  }

  return { existingObjects, existingLinks }
}

export function collectEditBatchLoadRequests(batchInput: EditBatchInput): EditBatchLoadRequests {
  const batch = normalizeEditBatch(batchInput)
  const objects = new Map<string, { objectTypeId: string; primaryId: string }>()
  const sourceLinks = new Map<string, { objectTypeId: string; objectId: string; linkId: string }>()
  const incidentLinks = new Map<string, { objectTypeId: string; objectId: string }>()

  for (const operation of batch.operations) {
    switch (operation.kind) {
      case "object.create":
      case "object.update":
      case "object.upsert":
        objects.set(objectKey(operation.objectTypeId, operation.primaryId), {
          objectTypeId: operation.objectTypeId,
          primaryId: operation.primaryId,
        })
        break
      case "object.delete":
        objects.set(objectKey(operation.objectTypeId, operation.primaryId), {
          objectTypeId: operation.objectTypeId,
          primaryId: operation.primaryId,
        })
        incidentLinks.set(objectKey(operation.objectTypeId, operation.primaryId), {
          objectTypeId: operation.objectTypeId,
          objectId: operation.primaryId,
        })
        break
      case "link.create":
      case "link.delete":
        objects.set(objectKey(operation.source.objectTypeId, operation.source.primaryId), {
          objectTypeId: operation.source.objectTypeId,
          primaryId: operation.source.primaryId,
        })
        objects.set(objectKey(operation.target.objectTypeId, operation.target.primaryId), {
          objectTypeId: operation.target.objectTypeId,
          primaryId: operation.target.primaryId,
        })
        sourceLinks.set(
          sourceLinkKey(
            operation.source.objectTypeId,
            operation.source.primaryId,
            operation.linkId
          ),
          {
            objectTypeId: operation.source.objectTypeId,
            objectId: operation.source.primaryId,
            linkId: operation.linkId,
          }
        )
        break
    }
  }

  return {
    objects: [...objects.values()],
    sourceLinks: [...sourceLinks.values()],
    incidentLinks: [...incidentLinks.values()],
  }
}

export function planEditBatchFromLoadedState(
  input: Omit<ValidateEditBatchInput, "storage"> & {
    readonly existingObjects: Map<string, ObjectRow>
    readonly existingLinks: Map<string, ObjectLinkRow[]>
  }
): EditCommitPlan {
  const batch = normalizeEditBatchWithOntology(normalizeEditBatch(input.batch), input)

  return analyzeEditBatch({
    ...input,
    batch,
  })
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
        "create",
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
    case "object.upsert": {
      const objectType = ctx.ontology.resolveObjectType(operation.objectTypeId)
      const primaryProperty = getPrimaryProperty(objectType)
      const properties = normalizeObjectEditProperties({
        objectType,
        properties: operation.properties,
        valueTypesById,
        path: `${objectType.id}.upsert`,
      })
      assertPrimaryPropertyMatchesRef(
        "upsert",
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

function analyzeEditBatch(input: EditAnalysisInput): EditCommitPlan {
  const valueTypesById = input.ontology.getValueTypesById()
  const objectStates = seedObjectStates(input)
  const linkIndex = seedLinkIndex(input.existingLinks)

  for (const operation of normalizeEditBatch(input.batch).operations) {
    switch (operation.kind) {
      case "object.create":
        applyObjectCreate(input, operation, objectStates)
        break
      case "object.update":
        applyObjectUpdate(operation, objectStates, valueTypesById)
        break
      case "object.upsert":
        applyObjectUpsert(input, operation, objectStates)
        break
      case "object.delete":
        applyObjectDelete(operation, objectStates, linkIndex)
        break
      case "link.create":
        applyLinkCreate(input, operation, objectStates, linkIndex, valueTypesById)
        break
      case "link.delete":
        applyLinkDelete(operation, objectStates, linkIndex)
        break
    }
  }

  const diff: EditCommitDiff = {
    objects: deriveObjectDiffs(objectStates, valueTypesById),
    links: deriveLinkDiffs(linkIndex),
  }

  return {
    batch: input.batch,
    diff,
    objects: buildObjectPlan(diff, objectStates),
    links: buildLinkPlan(diff, linkIndex),
  }
}

function seedObjectStates(input: {
  readonly ontology: ValidateEditBatchInput["ontology"]
  readonly existingObjects: Map<string, ObjectRow>
}): Map<string, ObjectState> {
  const states = new Map<string, ObjectState>()
  for (const row of input.existingObjects.values()) {
    const objectType = input.ontology.resolveObjectType(row.objectTypeId)
    const properties = { ...row.properties } as Record<string, JsonValue>
    states.set(objectKey(row.objectTypeId, row.primaryId), {
      objectTypeId: row.objectTypeId,
      primaryId: row.primaryId,
      objectType,
      baselineExists: true,
      baselineProperties: { ...properties },
      present: true,
      properties,
    })
  }
  return states
}

function seedLinkIndex(existingLinks: Map<string, ObjectLinkRow[]>): LinkStateIndex {
  const index: LinkStateIndex = {
    byKey: new Map(),
    bySourceLink: new Map(),
    byObject: new Map(),
  }
  for (const links of existingLinks.values()) {
    for (const row of links) {
      const key = linkKey(
        row.sourceTypeId,
        row.sourceId,
        row.linkId,
        row.targetTypeId,
        row.targetId
      )
      // A physical link can be returned by both the source-link and incident loaders; keep the
      // first occurrence (they are the same row).
      if (index.byKey.has(key)) continue
      const baselineProperties = (row.properties ?? undefined) as
        | Record<string, JsonValue>
        | undefined
      const state: LinkState = {
        source: { objectTypeId: row.sourceTypeId, primaryId: row.sourceId },
        linkId: row.linkId,
        target: { objectTypeId: row.targetTypeId, primaryId: row.targetId },
        baselineExists: true,
        baselineProperties: baselineProperties ? { ...baselineProperties } : undefined,
        present: true,
        properties: baselineProperties ? { ...baselineProperties } : undefined,
      }
      index.byKey.set(key, state)
      addLinkToIndexes(index, key, state)
    }
  }
  return index
}

function applyObjectCreate(
  input: Pick<ValidateEditBatchInput, "ontology">,
  operation: Extract<EditOperation, { kind: "object.create" }>,
  states: Map<string, ObjectState>
): void {
  const key = objectKey(operation.objectTypeId, operation.primaryId)
  const existing = states.get(key)
  if (existing?.present) {
    throw new EditBatchError(
      `[Sixb] EditBatch cannot create existing object '${operation.objectTypeId}:${operation.primaryId}'.`
    )
  }

  const properties = { ...operation.properties }
  if (existing) {
    // Re-creating a key that was deleted earlier in the batch. The baseline is preserved, so the
    // net effect is derived later: an `update` if the row existed in storage, a `create` otherwise.
    existing.present = true
    existing.properties = properties
    return
  }

  states.set(key, {
    objectTypeId: operation.objectTypeId,
    primaryId: operation.primaryId,
    objectType: input.ontology.resolveObjectType(operation.objectTypeId),
    baselineExists: false,
    present: true,
    properties,
  })
}

function applyObjectUpsert(
  input: Pick<ValidateEditBatchInput, "ontology">,
  operation: EditObjectUpsertOperation,
  states: Map<string, ObjectState>
): void {
  const key = objectKey(operation.objectTypeId, operation.primaryId)
  const existing = states.get(key)

  if (existing?.present) {
    existing.properties = {
      ...existing.properties,
      ...operation.properties,
    }
    assertRequiredProperties(existing.objectType, existing.properties)
    return
  }

  const objectType =
    existing?.objectType ?? input.ontology.resolveObjectType(operation.objectTypeId)
  const properties = { ...operation.properties }
  assertRequiredProperties(objectType, properties)

  if (existing) {
    existing.present = true
    existing.properties = properties
    return
  }

  states.set(key, {
    objectTypeId: operation.objectTypeId,
    primaryId: operation.primaryId,
    objectType,
    baselineExists: false,
    present: true,
    properties,
  })
}

function applyObjectUpdate(
  operation: EditObjectUpdateOperation,
  states: Map<string, ObjectState>,
  valueTypesById: ReadonlyMap<string, ValueType>
): void {
  const state = requireActiveObjectState(states, {
    objectTypeId: operation.objectTypeId,
    primaryId: operation.primaryId,
  })

  for (const [propertyId, value] of Object.entries(operation.properties)) {
    const property = state.objectType.properties.find((candidate) => candidate.id === propertyId)
    if (!property) continue
    state.properties[propertyId] = normalizeObjectEditProperties({
      objectType: state.objectType,
      properties: { [propertyId]: value },
      valueTypesById,
      path: `${state.objectType.id}.set`,
    })[propertyId]
  }

  assertRequiredProperties(state.objectType, state.properties)
}

function applyObjectDelete(
  operation: EditObjectDeleteOperation,
  states: Map<string, ObjectState>,
  linkIndex: LinkStateIndex
): void {
  const state = requireActiveObjectState(states, {
    objectTypeId: operation.objectTypeId,
    primaryId: operation.primaryId,
  })
  state.present = false
  deleteIncidentLinks(
    { objectTypeId: operation.objectTypeId, primaryId: operation.primaryId },
    linkIndex
  )
}

function applyLinkCreate(
  input: Pick<ValidateEditBatchInput, "projectId" | "ontology">,
  operation: EditLinkCreateOperation,
  objectStates: Map<string, ObjectState>,
  linkIndex: LinkStateIndex,
  valueTypesById: ReadonlyMap<string, ValueType>
): void {
  requireActiveObjectState(objectStates, operation.source)
  requireActiveObjectState(objectStates, operation.target)

  const sourceObjectType = input.ontology.resolveObjectType(operation.source.objectTypeId)
  const linkDefinition = requireLinkDefinition(sourceObjectType, operation.linkId)
  const key = linkKey(
    operation.source.objectTypeId,
    operation.source.primaryId,
    operation.linkId,
    operation.target.objectTypeId,
    operation.target.primaryId
  )
  const existing = linkIndex.byKey.get(key)
  // Only merge into properties that are live in the batch. A link deleted earlier in the batch is
  // absent, so re-creating it starts from an empty property set (a full replacement) rather than
  // resurrecting the pre-delete properties.
  const currentProperties = existing?.present ? existing.properties : undefined

  validateLinkProperties(
    sourceObjectType,
    linkDefinition,
    operation.properties,
    currentProperties,
    valueTypesById
  )
  assertLinkCardinality(operation, linkDefinition, linkIndex)

  const merged = {
    ...(currentProperties ?? {}),
    ...(operation.properties ?? {}),
  }
  const properties = Object.keys(merged).length > 0 ? merged : undefined

  if (!existing) {
    const state: LinkState = {
      source: operation.source,
      linkId: operation.linkId,
      target: operation.target,
      baselineExists: false,
      present: true,
      properties,
    }
    linkIndex.byKey.set(key, state)
    addLinkToIndexes(linkIndex, key, state)
    return
  }

  existing.properties = properties
  if (!existing.present) {
    existing.present = true
    addLinkToIndexes(linkIndex, key, existing)
  }
}

function applyLinkDelete(
  operation: EditLinkDeleteOperation,
  objectStates: Map<string, ObjectState>,
  linkIndex: LinkStateIndex
): void {
  requireActiveObjectState(objectStates, operation.source)
  requireActiveObjectState(objectStates, operation.target)

  const key = linkKey(
    operation.source.objectTypeId,
    operation.source.primaryId,
    operation.linkId,
    operation.target.objectTypeId,
    operation.target.primaryId
  )
  const existing = linkIndex.byKey.get(key)
  if (!existing || !existing.present) {
    return
  }

  removeLinkFromIndexes(linkIndex, key, existing)
  existing.present = false
  existing.properties = undefined
}

function deleteIncidentLinks(ref: EditObjectRef, linkIndex: LinkStateIndex): void {
  const keys = linkIndex.byObject.get(objectKey(ref.objectTypeId, ref.primaryId))
  if (!keys) return

  for (const key of [...keys]) {
    const state = linkIndex.byKey.get(key)
    if (!state || !state.present) continue
    removeLinkFromIndexes(linkIndex, key, state)
    state.present = false
    state.properties = undefined
  }
}

function requireActiveObjectState(
  states: Map<string, ObjectState>,
  ref: EditObjectRef
): ObjectState {
  const state = states.get(objectKey(ref.objectTypeId, ref.primaryId))
  if (!state || !state.present) {
    throw new EditBatchError(
      `[Sixb] EditBatch references missing object '${ref.objectTypeId}:${ref.primaryId}'.`
    )
  }
  return state
}

function assertLinkCardinality(
  operation: EditLinkCreateOperation,
  linkDefinition: ObjectLink,
  linkIndex: LinkStateIndex
): void {
  if (linkDefinition.cardinality !== "one") return

  const keys = linkIndex.bySourceLink.get(
    sourceLinkKey(operation.source.objectTypeId, operation.source.primaryId, operation.linkId)
  )
  if (!keys) return

  for (const key of keys) {
    const candidate = linkIndex.byKey.get(key)
    if (!candidate || !candidate.present) continue
    if (
      candidate.target.objectTypeId === operation.target.objectTypeId &&
      candidate.target.primaryId === operation.target.primaryId
    ) {
      continue
    }
    throw new EditBatchError(
      `[Sixb] Link ${operation.source.objectTypeId}.${operation.linkId} has cardinality 'one'` +
        ` and already points to ${candidate.target.objectTypeId}:${candidate.target.primaryId}`
    )
  }
}

function linkSourceIndexKey(state: LinkState): string {
  return sourceLinkKey(state.source.objectTypeId, state.source.primaryId, state.linkId)
}

function addLinkToIndexes(index: LinkStateIndex, key: string, state: LinkState): void {
  addToKeySet(index.bySourceLink, linkSourceIndexKey(state), key)
  addToKeySet(index.byObject, objectKey(state.source.objectTypeId, state.source.primaryId), key)
  addToKeySet(index.byObject, objectKey(state.target.objectTypeId, state.target.primaryId), key)
}

function removeLinkFromIndexes(index: LinkStateIndex, key: string, state: LinkState): void {
  removeFromKeySet(index.bySourceLink, linkSourceIndexKey(state), key)
  removeFromKeySet(
    index.byObject,
    objectKey(state.source.objectTypeId, state.source.primaryId),
    key
  )
  removeFromKeySet(
    index.byObject,
    objectKey(state.target.objectTypeId, state.target.primaryId),
    key
  )
}

function addToKeySet(index: Map<string, Set<string>>, indexKey: string, value: string): void {
  const existing = index.get(indexKey)
  if (existing) {
    existing.add(value)
    return
  }
  index.set(indexKey, new Set([value]))
}

function removeFromKeySet(index: Map<string, Set<string>>, indexKey: string, value: string): void {
  const existing = index.get(indexKey)
  if (!existing) return
  existing.delete(value)
  if (existing.size === 0) {
    index.delete(indexKey)
  }
}

function deriveObjectDiffs(
  states: Map<string, ObjectState>,
  valueTypesById: ReadonlyMap<string, ValueType>
): EditCommitDiff["objects"] {
  const diffs: EditCommitDiff["objects"][number][] = []

  for (const state of states.values()) {
    if (!state.baselineExists && !state.present) {
      // Created and then deleted within the batch (or only referenced) — no net change.
      continue
    }
    if (!state.baselineExists) {
      diffs.push({
        objectTypeId: state.objectTypeId,
        primaryId: state.primaryId,
        operation: "create",
        changedProperties: Object.keys(state.properties).sort(compareStrings),
      })
      continue
    }
    if (!state.present) {
      diffs.push({
        objectTypeId: state.objectTypeId,
        primaryId: state.primaryId,
        operation: "delete",
        changedProperties: [],
      })
      continue
    }

    const changedProperties = computeChangedObjectProperties(state, valueTypesById)
    if (changedProperties.length === 0) continue
    diffs.push({
      objectTypeId: state.objectTypeId,
      primaryId: state.primaryId,
      operation: "update",
      changedProperties,
    })
  }

  return diffs.sort(compareObjectDiffs)
}

function deriveLinkDiffs(linkIndex: LinkStateIndex): EditCommitDiff["links"] {
  const diffs: EditCommitDiff["links"][number][] = []

  for (const state of linkIndex.byKey.values()) {
    if (!state.baselineExists && !state.present) continue
    if (!state.baselineExists) {
      diffs.push({
        operation: "create",
        source: state.source,
        linkId: state.linkId,
        target: state.target,
      })
      continue
    }
    if (!state.present) {
      diffs.push({
        operation: "delete",
        source: state.source,
        linkId: state.linkId,
        target: state.target,
      })
      continue
    }
    if (jsonValuesEqual(state.baselineProperties ?? {}, state.properties ?? {})) continue
    diffs.push({
      operation: "update",
      source: state.source,
      linkId: state.linkId,
      target: state.target,
    })
  }

  return diffs.sort(compareLinkDiffs)
}

function computeChangedObjectProperties(
  state: ObjectState,
  valueTypesById: ReadonlyMap<string, ValueType>
): string[] {
  const baseline = state.baselineProperties ?? {}
  const working = state.properties
  const changed: string[] = []

  for (const property of state.objectType.properties) {
    if (property.mode === "telemetry") continue
    const before = normalizeComparableProperty(
      state.objectType,
      property.id,
      baseline[property.id],
      valueTypesById
    )
    const after = normalizeComparableProperty(
      state.objectType,
      property.id,
      working[property.id],
      valueTypesById
    )
    if (!jsonValuesEqual(before, after)) {
      changed.push(property.id)
    }
  }

  return changed.sort(compareStrings)
}

function normalizeComparableProperty(
  objectType: ObjectTypeWithPropertyTokens,
  propertyId: string,
  value: JsonValue | undefined,
  valueTypesById: ReadonlyMap<string, ValueType>
): JsonValue | undefined {
  if (value === undefined) {
    return undefined
  }
  return normalizeObjectEditProperties({
    objectType,
    properties: { [propertyId]: value },
    valueTypesById,
    path: `${objectType.id}.compare`,
  })[propertyId]
}

function assertPrimaryPropertyMatchesRef(
  operation: "create" | "upsert",
  objectType: ObjectTypeWithPropertyTokens,
  primaryPropertyId: string,
  primaryId: string,
  properties: Record<string, JsonValue>
): void {
  if (properties[primaryPropertyId] !== primaryId) {
    throw new EditBatchError(
      `[Sixb] EditBatch ${operation} '${objectType.id}:${primaryId}' must include matching primary property '${primaryPropertyId}'.`
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

function buildObjectPlan(
  diff: EditCommitDiff,
  states: Map<string, ObjectState>
): EditCommitPlan["objects"] {
  const upserts: EditObjectUpsertPlan[] = []
  const deletes: EditObjectDeletePlan[] = []

  for (const entry of diff.objects) {
    if (entry.operation === "delete") {
      const state = states.get(objectKey(entry.objectTypeId, entry.primaryId))
      deletes.push({
        objectTypeId: entry.objectTypeId,
        primaryId: entry.primaryId,
        ...(state?.baselineProperties !== undefined
          ? { previousProperties: { ...state.baselineProperties } }
          : {}),
      })
      continue
    }

    const state = states.get(objectKey(entry.objectTypeId, entry.primaryId))
    if (!state || !state.present) {
      throw new EditBatchError(
        `[Sixb] EditBatch could not build ${entry.operation} plan for missing object '${entry.objectTypeId}:${entry.primaryId}'.`
      )
    }
    upserts.push({
      objectTypeId: entry.objectTypeId,
      primaryId: entry.primaryId,
      properties: { ...state.properties },
      ...(state.baselineProperties !== undefined
        ? { previousProperties: { ...state.baselineProperties } }
        : {}),
      operation: entry.operation,
    })
  }

  return {
    upserts,
    deletes,
  }
}

function buildLinkPlan(diff: EditCommitDiff, linkIndex: LinkStateIndex): EditCommitPlan["links"] {
  const upserts: EditLinkUpsertPlan[] = []
  const deletes: EditLinkDeletePlan[] = []

  for (const entry of diff.links) {
    if (entry.operation === "delete") {
      const state = linkIndex.byKey.get(
        linkKey(
          entry.source.objectTypeId,
          entry.source.primaryId,
          entry.linkId,
          entry.target.objectTypeId,
          entry.target.primaryId
        )
      )
      deletes.push({
        source: entry.source,
        linkId: entry.linkId,
        target: entry.target,
        ...(state?.baselineProperties !== undefined
          ? { previousProperties: { ...state.baselineProperties } }
          : {}),
      })
      continue
    }

    const state = linkIndex.byKey.get(
      linkKey(
        entry.source.objectTypeId,
        entry.source.primaryId,
        entry.linkId,
        entry.target.objectTypeId,
        entry.target.primaryId
      )
    )
    if (!state || !state.present) {
      throw new EditBatchError(
        `[Sixb] EditBatch could not build ${entry.operation} plan for missing link '${entry.source.objectTypeId}:${entry.source.primaryId}:${entry.linkId}:${entry.target.objectTypeId}:${entry.target.primaryId}'.`
      )
    }
    upserts.push({
      source: entry.source,
      linkId: entry.linkId,
      target: entry.target,
      ...(state.properties && Object.keys(state.properties).length > 0
        ? { properties: { ...state.properties } }
        : {}),
      ...(state.baselineProperties !== undefined
        ? { previousProperties: { ...state.baselineProperties } }
        : {}),
      operation: entry.operation,
    })
  }

  return {
    upserts,
    deletes,
  }
}
