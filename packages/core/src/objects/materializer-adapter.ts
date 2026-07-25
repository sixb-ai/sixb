/**
 * Runtime translation onto the ontology Materializer.
 *
 * Every typed and dynamic object/link mutation lowers to canonical Materializer operations here and
 * every Materializer result is mapped back to the public runtime shapes. The adapter owns no
 * ontology semantics: authority classification, effective resolution, validation, and event
 * construction all happen inside the Materializer's single commit.
 */

import { randomUUID } from "node:crypto"
import type { JsonValue } from "../json"
import type {
  EditCommitResult,
  EffectiveObjectSnapshot,
  MaterializationItemError,
  OntologyEditOperation,
  OntologyLinkRef,
  OntologyObjectRef,
  OntologyOperationOutcome,
} from "../materialization/model"
import { normalizeJsonProperties } from "../materializer"
import type { ObjectLink, ValueType } from "../ontology"
import { OntologyValidationError } from "../ontology/errors"
import type { ObjectTypeWithPropertyTokens } from "../ontology/tokens"
import {
  assertKnownProperties,
  assertLinkTargetType,
  normalizeLinkProperties,
  normalizeObjectProperties,
  validateLinkProperties,
  validateObjectProperties,
} from "../ontology/validation"
import type { SixbRuntimeContext } from "../runtime/types"
import type { ObjectRow } from "../storage"
import { ObjectError } from "./errors"

/** The runtime pieces one commit needs: Materializer plus post-commit fact publication. */
export type RuntimeMaterializerContext = Pick<
  SixbRuntimeContext,
  "projectId" | "materializer" | "committedFacts"
>

/** One caller-supplied batch item, lowered to the operations it contributes. */
export interface RuntimeBatchGroup {
  /** Position in the caller's input array; item errors are reported against it. */
  readonly index: number
  readonly operations: readonly OntologyEditOperation[]
}

export interface RuntimeBatchCommit {
  readonly commit: EditCommitResult | null
  /** Outcomes per input position, in the order the item's operations were submitted. */
  readonly outcomes: ReadonlyMap<number, readonly OntologyOperationOutcome[]>
}

/**
 * Commits ordered operations as one atomic runtime commit.
 *
 * A fresh request id per call keeps each runtime mutation its own commit; the Materializer's
 * idempotency replay then only collapses a retry of the very same request.
 */
export async function commitRuntimeOperations(
  ctx: RuntimeMaterializerContext,
  operations: readonly OntologyEditOperation[]
): Promise<EditCommitResult> {
  const commit = await ctx.materializer.edits.commit({
    mode: "atomic",
    source: { kind: "runtime", requestId: randomUUID() },
    operations,
    expectedObjects: [],
    expectedLinks: [],
    expectedLinkScopes: [],
  })
  await publishCommittedFacts(ctx, commit)
  return commit
}

/**
 * Commits grouped batch operations as one ordered continue-mode transaction.
 *
 * Successful items apply against one evolving authority state while semantic failures are recorded
 * per item. Provider, serialization, and CAS failures still roll the whole transaction back.
 */
export async function commitRuntimeBatch(
  ctx: RuntimeMaterializerContext,
  groups: readonly RuntimeBatchGroup[]
): Promise<RuntimeBatchCommit> {
  const operations = groups.flatMap((group) => group.operations)
  if (operations.length === 0) {
    return { commit: null, outcomes: new Map() }
  }

  const commit = await ctx.materializer.edits.commit({
    mode: "continue",
    source: { kind: "runtime", requestId: randomUUID() },
    operations,
  })
  await publishCommittedFacts(ctx, commit)

  const byId = new Map(commit.outcomes.map((outcome) => [outcome.id, outcome]))
  const outcomes = new Map<number, readonly OntologyOperationOutcome[]>()
  for (const group of groups) {
    outcomes.set(
      group.index,
      group.operations.map((operation) => requireOutcome(byId, operation.id))
    )
  }
  return { commit, outcomes }
}

/**
 * Assigns the canonical operation id for one batch item.
 *
 * Ids derive from the caller's original ordinal so outcomes map back to input positions even when
 * earlier items failed local validation and never reached the Materializer.
 */
export function runtimeOperationId(index: number, subOrdinal = 0): string {
  return subOrdinal === 0 ? `op:${index}` : `op:${index}.${subOrdinal}`
}

export interface NormalizedRuntimeObject {
  readonly primaryId: string
  /** Managed authority values; identity lives in the object ref, never in the properties. */
  readonly properties: Readonly<Record<string, JsonValue>>
}

/**
 * Validates and normalizes one runtime object input at the SDK/service boundary.
 *
 * Shape and value-type errors surface here so a batch can report them against the caller's original
 * position. Authority classification, required-property enforcement, and cardinality stay in the
 * Materializer, which validates the resolved effective object instead of the request.
 */
export function normalizeRuntimeObject(input: {
  readonly objectType: ObjectTypeWithPropertyTokens
  readonly primaryPropertyId: string
  readonly properties: Record<string, unknown>
  readonly valueTypesById: ReadonlyMap<string, ValueType>
}): NormalizedRuntimeObject {
  const { objectType, primaryPropertyId, properties, valueTypesById } = input
  assertKnownProperties(objectType, properties)
  validateObjectProperties(objectType, properties, valueTypesById)

  const primaryValue = properties[primaryPropertyId]
  if (primaryValue === undefined || primaryValue === null) {
    throw new OntologyValidationError(
      `[Sixb] Missing primary property '${primaryPropertyId}' in upsert for '${objectType.id}'`
    )
  }

  const normalized = normalizeObjectProperties(
    objectType.properties,
    properties,
    valueTypesById,
    objectType.id
  )
  const { [primaryPropertyId]: _identity, ...managed } = normalized
  return {
    primaryId: String(primaryValue),
    properties: normalizeJsonProperties(managed, `${objectType.id} properties`),
  }
}

/**
 * Validates and normalizes one runtime link input.
 *
 * Managed link authority carries the complete property set, so required link properties must be
 * present in the request rather than inherited from the stored edge.
 */
export function normalizeRuntimeLink(input: {
  readonly objectType: ObjectTypeWithPropertyTokens
  readonly linkDefinition: ObjectLink
  readonly linkId: string
  readonly targetTypeId: string
  readonly properties?: Record<string, unknown>
  readonly valueTypesById: ReadonlyMap<string, ValueType>
  readonly isValidLinkTarget: (expected: string | string[], actual: string) => boolean
}): Readonly<Record<string, JsonValue>> | undefined {
  const { objectType, linkDefinition, linkId, targetTypeId, properties, valueTypesById } = input
  assertLinkTargetType(objectType.id, linkId, linkDefinition, targetTypeId, input.isValidLinkTarget)
  validateLinkProperties(objectType, linkDefinition, properties, undefined, valueTypesById)
  const normalized = normalizeLinkProperties(objectType, linkDefinition, properties, valueTypesById)
  if (normalized === undefined) return undefined
  return normalizeJsonProperties(normalized, `${objectType.id}.${linkId} properties`)
}

export function objectUpsertOperation(input: {
  readonly id: string
  readonly ref: OntologyObjectRef
  readonly properties: Readonly<Record<string, JsonValue>>
}): OntologyEditOperation {
  return { id: input.id, kind: "object.upsert", ref: input.ref, properties: input.properties }
}

export function linkUpsertOperation(input: {
  readonly id: string
  readonly ref: OntologyLinkRef
  readonly properties?: Readonly<Record<string, JsonValue>>
}): OntologyEditOperation {
  return {
    id: input.id,
    kind: "link.upsert",
    ref: input.ref,
    ...(input.properties !== undefined ? { properties: input.properties } : {}),
  }
}

export function linkDeleteOperation(input: {
  readonly id: string
  readonly ref: OntologyLinkRef
}): OntologyEditOperation {
  return { id: input.id, kind: "link.delete", ref: input.ref }
}

/** Reads the outcomes one batch item produced; the commit returns one per submitted operation. */
export function requireItemOutcomes(
  commit: RuntimeBatchCommit,
  index: number
): readonly OntologyOperationOutcome[] {
  const outcomes = commit.outcomes.get(index)
  if (!outcomes || outcomes.length === 0) {
    throw new ObjectError(`[Sixb] Materializer returned no outcome for batch item ${index}.`)
  }
  return outcomes
}

/** Reads the effective object an ok outcome produced; runtime object writes always resolve one. */
export function requireEffectiveObject(outcome: OntologyOperationOutcome): EffectiveObjectSnapshot {
  if (!outcome.ok || !outcome.object) {
    throw new ObjectError(`[Sixb] Materializer returned no effective object for '${outcome.id}'.`)
  }
  return outcome.object
}

export function toObjectRow(projectId: string, snapshot: EffectiveObjectSnapshot): ObjectRow {
  return {
    projectId,
    objectTypeId: snapshot.ref.objectTypeId,
    primaryId: snapshot.ref.primaryId,
    properties: structuredClone(snapshot.properties) as Record<string, unknown>,
    createdAt: new Date(snapshot.createdAt),
    updatedAt: new Date(snapshot.updatedAt),
    version: snapshot.version,
    lastCommitId: snapshot.lastCommitId,
    sourceEventId: undefined,
  }
}

/** Rehydrates a persisted item error into the public runtime error type. */
export function toItemError(error: MaterializationItemError): Error {
  switch (error.code) {
    case "validation":
      return new OntologyValidationError(error.message)
  }
}

function requireOutcome(
  outcomes: ReadonlyMap<string, OntologyOperationOutcome>,
  id: string
): OntologyOperationOutcome {
  const outcome = outcomes.get(id)
  if (!outcome) {
    throw new ObjectError(`[Sixb] Materializer returned no outcome for '${id}'.`)
  }
  return outcome
}

/**
 * Hands committed facts to the in-process publisher.
 *
 * The commit is already durable, so a delivery failure is reported by the publisher rather than
 * failing the caller's write.
 */
async function publishCommittedFacts(
  ctx: RuntimeMaterializerContext,
  commit: EditCommitResult
): Promise<void> {
  if (commit.eventCount === 0 || !ctx.committedFacts) return
  await ctx.committedFacts.drain()
}
