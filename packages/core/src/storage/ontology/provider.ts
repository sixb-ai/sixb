import { stableJsonStringify } from "../../json"
import {
  MaterializationConflictError,
  MaterializationValidationError,
} from "../../materialization/errors"
import type { OntologyLinkRef, OntologyObjectRef } from "../../materialization/model"
import { linkRefSortKey, objectRefSortKey, projectionEntityKey } from "../../materialization/refs"
import type { OntologyCommitOriginSelector, OntologyCommitWrite } from "./commits"
import type { MaterializationPlanWorkItem, MaterializationWorkRecord } from "./materializations"
import type {
  AssertSourceMaterializationExecutionInput,
  BeginSourceMaterializationInput,
  OntologySourceRecord,
  StageSourceAssertion,
} from "./sources"

/**
 * Provider-neutral validation and ordering used by ontology storage implementations.
 *
 * @internal Repository storage providers only. Application code must use the capability contracts
 * from `@sixb/core/storage` instead.
 */

export {
  appendScopeSnapshot,
  finishScopeAccumulator,
  startScopeAccumulator,
} from "./in-memory/materializations-state"
export {
  assertMaterializationHeader,
  assertPageRows,
  assertPlanChunkCorrelations,
  assertWorkRecord,
  compareCardinalityWork,
  compareEventWork,
  comparePlanWork,
  invalidCorrelation,
  materializationChunkRows,
  materializationPlanItems,
  workUniquenessKey,
} from "./in-memory/materializations-work"

export function uniqueSorted<T>(
  values: readonly T[],
  identity: (value: T) => string,
  sortKey: (value: T) => string
): T[] {
  return [...new Map(values.map((value) => [identity(value), value])).values()].sort(
    (left, right) => sortKey(left).localeCompare(sortKey(right))
  )
}

export function overrideEntityColumns(
  kind: "object" | "link",
  ref: OntologyObjectRef | OntologyLinkRef
): {
  readonly sortKey: string
  readonly objectTypeId: string | null
  readonly primaryId: string | null
  readonly sourceTypeId: string | null
  readonly sourcePrimaryId: string | null
  readonly linkId: string | null
  readonly targetTypeId: string | null
  readonly targetPrimaryId: string | null
} {
  if (kind === "object") {
    const object = ref as OntologyObjectRef
    return {
      sortKey: objectRefSortKey(object),
      objectTypeId: object.objectTypeId,
      primaryId: object.primaryId,
      sourceTypeId: null,
      sourcePrimaryId: null,
      linkId: null,
      targetTypeId: null,
      targetPrimaryId: null,
    }
  }
  const link = ref as OntologyLinkRef
  return {
    sortKey: linkRefSortKey(link),
    objectTypeId: null,
    primaryId: null,
    sourceTypeId: link.source.objectTypeId,
    sourcePrimaryId: link.source.primaryId,
    linkId: link.linkId,
    targetTypeId: link.target.objectTypeId,
    targetPrimaryId: link.target.primaryId,
  }
}

export function sameNonnegativeCounts(actual: object, expected: object): boolean {
  const actualCounts = actual as Record<string, unknown>
  return Object.entries(expected).every(
    ([key, value]) =>
      typeof value === "number" &&
      Number.isSafeInteger(actualCounts[key]) &&
      actualCounts[key] === value &&
      value >= 0
  )
}

export function effectiveConflict(message: string): MaterializationConflictError {
  return new MaterializationConflictError("effective-state", message)
}

export function materializationWorkColumns(record: MaterializationWorkRecord): {
  readonly lane: "none" | "apply" | "cardinality" | "event"
  readonly rankOne: number
  readonly rankTwo: number
  readonly sortOne: string
  readonly sortTwo: string
} {
  if (record.kind === "plan") {
    return {
      lane: "apply",
      rankOne: record.applyPhase,
      rankTwo: materializationPlanKindRank(record.item.kind),
      sortOne: record.sortKey,
      sortTwo: "",
    }
  }
  if (record.kind === "cardinality") {
    return {
      lane: "cardinality",
      rankOne: 0,
      rankTwo: 0,
      sortOne: record.scopeSortKey,
      sortTwo: record.linkSortKey,
    }
  }
  if (record.kind === "event") {
    return {
      lane: "event",
      rankOne: record.eventKindRank,
      rankTwo: 0,
      sortOne: record.sortKey,
      sortTwo: "",
    }
  }
  return { lane: "none", rankOne: 0, rankTwo: 0, sortOne: "", sortTwo: "" }
}

function materializationPlanKindRank(kind: MaterializationPlanWorkItem["kind"]): number {
  switch (kind) {
    case "object-override-upsert":
      return 0
    case "object-override-delete":
      return 1
    case "link-override-upsert":
      return 2
    case "link-override-delete":
      return 3
    case "point-upsert":
      return 4
    case "link-delete":
      return 5
    case "object-delete":
      return 6
    case "object-upsert":
      return 7
    case "link-upsert":
      return 8
  }
}

export function duplicateMaterializationWork(key: string): MaterializationConflictError {
  return new MaterializationConflictError(
    "effective-state",
    `Duplicate materialization work key '${key}'.`
  )
}

export function canonicalJson(value: unknown): string {
  return stableJsonStringify(value)
}

export function originColumns(origin: OntologyCommitWrite["origin"]): {
  readonly kind: string
  readonly runId: string | null
  readonly batchOrdinal: number | null
} {
  if (origin.kind === "action") {
    return { kind: "action", runId: origin.runId, batchOrdinal: null }
  }
  if (origin.kind === "projection") {
    return { kind: "projection", runId: origin.projectionRunId, batchOrdinal: null }
  }
  if (origin.kind === "telemetry" && origin.source.kind === "projection") {
    return {
      kind: "telemetry",
      runId: origin.source.projectionRunId,
      batchOrdinal: origin.source.batchOrdinal,
    }
  }
  return { kind: origin.kind, runId: null, batchOrdinal: null }
}

export function originWhere(origin: OntologyCommitOriginSelector): {
  readonly kind: string
  readonly runId: string
  readonly batchOrdinal: number | null
} {
  if (origin.kind === "action") {
    return { kind: origin.kind, runId: origin.actionRunId, batchOrdinal: null }
  }
  if (origin.kind === "projection") {
    return { kind: origin.kind, runId: origin.projectionRunId, batchOrdinal: null }
  }
  return {
    kind: origin.kind,
    runId: origin.projectionRunId,
    batchOrdinal: origin.batchOrdinal,
  }
}

export function objectRefFromColumns(row: {
  readonly object_type_id: string
  readonly primary_id: string
}): OntologyObjectRef {
  return { objectTypeId: row.object_type_id, primaryId: row.primary_id }
}

export function linkRefFromColumns(row: {
  readonly source_type_id: string
  readonly source_id: string
  readonly link_id: string
  readonly target_type_id: string
  readonly target_id: string
}): OntologyLinkRef {
  return {
    source: { objectTypeId: row.source_type_id, primaryId: row.source_id },
    linkId: row.link_id,
    target: { objectTypeId: row.target_type_id, primaryId: row.target_id },
  }
}

export function assertNonblank(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MaterializationValidationError(`${label} must be nonblank.`)
  }
}

export function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new MaterializationValidationError(`${label} must be a positive safe integer.`)
  }
}

export function assertNonnegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MaterializationValidationError(`${label} must be a nonnegative safe integer.`)
  }
}

export function assertTimestamp(value: string, label: string, canonical = true): number {
  const milliseconds = Date.parse(value)
  if (
    !Number.isFinite(milliseconds) ||
    (canonical && new Date(milliseconds).toISOString() !== value)
  ) {
    throw new MaterializationValidationError(
      `${label} must be ${canonical ? "a canonical UTC" : "a valid"} timestamp.`
    )
  }
  return milliseconds
}

export function sourceEntityKey(row: StageSourceAssertion): string {
  return projectionEntityKey(row.assertion)
}

export function sourceMaterializationIdentity(
  input: BeginSourceMaterializationInput
): NonNullable<AssertSourceMaterializationExecutionInput["identity"]> {
  return {
    projectionKind: input.projectionKind,
    protocol: input.protocol,
    datasetVersion: input.datasetVersion,
    projectionRevision: input.projectionRevision,
    ownershipHash: input.ownershipHash,
    ontologyRevision: input.ontologyRevision,
  }
}

export function assertSourceBeginInput(input: BeginSourceMaterializationInput): void {
  assertSourceWriteIdentity(input)
  if (input.projectionKind !== "object" && input.projectionKind !== "link") {
    throw new MaterializationValidationError("Source projection kind must be 'object' or 'link'.")
  }
  if (input.protocol !== "replacement") {
    throw new MaterializationValidationError(
      "Source materialization protocol must be 'replacement'."
    )
  }
  assertNonblank(input.projectionRevision, "Source projection revision")
  assertNonblank(input.ownershipHash, "Source ownership hash")
  assertNonblank(input.ontologyRevision, "Source ontology revision")
  assertNonblank(input.datasetVersion.datasetId, "Source dataset id")
  assertNonblank(input.datasetVersion.versionId, "Source dataset version id")
  assertTimestamp(input.datasetVersion.createdAt, "Source dataset version createdAt", true)
  assertTimestamp(input.createdAt, "Source createdAt", true)
}

export function assertSourceWriteIdentity(input: {
  readonly projectId: string
  readonly source: { readonly projectionId: string }
  readonly materializationId: string
  readonly execution: { readonly projectionRunId: string; readonly executionToken: string }
}): void {
  assertSourceProject(input)
  assertNonblank(input.materializationId, "Source materialization id")
  assertSourceExecutionIdentity(input.execution.projectionRunId, input.execution.executionToken)
}

export function assertSourceProject(input: {
  readonly projectId: string
  readonly source: { readonly projectionId: string }
}): void {
  assertNonblank(input.projectId, "Source project id")
  assertNonblank(input.source.projectionId, "Source projection id")
}

export function assertSourceExecutionIdentity(runId: string, token: string): void {
  assertNonblank(runId, "Source projection run id")
  assertNonblank(token, "Source execution token")
}

export function assertSourceCandidateOwner(
  manifest: OntologySourceRecord,
  execution: { readonly projectionRunId: string; readonly executionToken: string }
): void {
  if (
    manifest.projectionRunId !== execution.projectionRunId ||
    manifest.executionToken !== execution.executionToken
  ) {
    throw sourceConflict(
      `Source materialization '${manifest.materializationId}' is owned by another execution.`
    )
  }
}

export function assertSourceStagedRow(
  projectionKind: OntologySourceRecord["projectionKind"],
  row: StageSourceAssertion
): void {
  if (!Number.isSafeInteger(row.stagingOrdinal) || row.stagingOrdinal < 0) {
    throw new MaterializationValidationError(
      "Source staging ordinal must be a nonnegative safe integer."
    )
  }
  assertSourceEntity(row.root, "Source root")
  assertSourceEntity(row.assertion, "Source assertion")
  if (projectionKind === "object" && row.root.kind !== "object") {
    throw new MaterializationValidationError(
      "Object projection source rows require an object root."
    )
  }
  if (projectionKind === "link" && (row.root.kind !== "link" || row.assertion.kind !== "link")) {
    throw new MaterializationValidationError(
      "Link projection source rows require a link root and link assertion."
    )
  }
}

function assertSourceEntity(entity: StageSourceAssertion["root"], label: string): void {
  if (entity.kind === "object") {
    assertNonblank(entity.ref.objectTypeId, `${label} object type id`)
    assertNonblank(entity.ref.primaryId, `${label} primary id`)
    return
  }
  assertNonblank(entity.ref.source.objectTypeId, `${label} source object type id`)
  assertNonblank(entity.ref.source.primaryId, `${label} source primary id`)
  assertNonblank(entity.ref.linkId, `${label} link id`)
  assertNonblank(entity.ref.target.objectTypeId, `${label} target object type id`)
  assertNonblank(entity.ref.target.primaryId, `${label} target primary id`)
}

export function sourceEntityColumns(entity: StageSourceAssertion["root"]): {
  readonly objectTypeId: string | null
  readonly primaryId: string | null
  readonly sourceTypeId: string | null
  readonly sourcePrimaryId: string | null
  readonly linkId: string | null
  readonly targetTypeId: string | null
  readonly targetPrimaryId: string | null
} {
  if (entity.kind === "object") {
    return {
      objectTypeId: entity.ref.objectTypeId,
      primaryId: entity.ref.primaryId,
      sourceTypeId: null,
      sourcePrimaryId: null,
      linkId: null,
      targetTypeId: null,
      targetPrimaryId: null,
    }
  }
  return {
    objectTypeId: null,
    primaryId: null,
    sourceTypeId: entity.ref.source.objectTypeId,
    sourcePrimaryId: entity.ref.source.primaryId,
    linkId: entity.ref.linkId,
    targetTypeId: entity.ref.target.objectTypeId,
    targetPrimaryId: entity.ref.target.primaryId,
  }
}

export function utf8SortKey(canonicalKey: string): string {
  let key = ""
  for (const byte of new TextEncoder().encode(canonicalKey)) {
    key += byte.toString(16).padStart(2, "0")
  }
  return key
}

export function isExactStagingManifest(
  row: OntologySourceRecord,
  input: BeginSourceMaterializationInput
): boolean {
  return (
    row.status === "staging" &&
    row.executionToken === input.execution.executionToken &&
    row.projectionRunId === input.execution.projectionRunId &&
    row.projectionKind === input.projectionKind &&
    row.protocol === input.protocol &&
    row.createdAt === input.createdAt &&
    row.datasetVersion.datasetId === input.datasetVersion.datasetId &&
    row.datasetVersion.versionId === input.datasetVersion.versionId &&
    row.datasetVersion.createdAt === input.datasetVersion.createdAt &&
    row.projectionRevision === input.projectionRevision &&
    row.ownershipHash === input.ownershipHash &&
    row.ontologyRevision === input.ontologyRevision
  )
}

export function sourceConflict(message: string): MaterializationConflictError {
  return new MaterializationConflictError("source-materialization", message)
}
