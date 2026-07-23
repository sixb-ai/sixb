import { createHash, randomUUID } from "node:crypto"
import { stableJsonStringify } from "../../json"
import {
  MaterializationConflictError,
  MaterializationValidationError,
} from "../../materialization/errors"
import type {
  EffectiveLinkSnapshot,
  OntologyLinkRef,
  OntologyObjectRef,
} from "../../materialization/model"
import { linkRefSortKey, objectRefSortKey, projectionEntityKey } from "../../materialization/refs"
import type { OntologyCommitOriginSelector, OntologyCommitWrite } from "./commits"
import type {
  FinalizeMaterializationInput,
  MaterializationEventWorkRecord,
  MaterializationLinkScopeState,
  MaterializationPlanChunk,
  MaterializationPlanHeader,
  MaterializationPlanWorkItem,
  MaterializationSession,
  MaterializationWorkRecord,
  SourceActivationWrite,
  StageMaterializationWorkInput,
  StreamMaterializationWorkInput,
} from "./materializations"
import { assertNonblank, assertTimestamp } from "./provider-validation"
import { assertWorkRecord, workUniquenessKey } from "./provider-work"
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
  assertNonblank,
  assertNonnegativeInteger,
  assertPositiveInteger,
  assertTimestamp,
} from "./provider-validation"
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
} from "./provider-work"

export interface LinkScopeAccumulator {
  readonly scopeSortKey: string
  readonly source: OntologyObjectRef
  readonly linkId: string
  readonly hash: ReturnType<typeof createHash>
  effectiveCount: number
}

export function startScopeAccumulator(
  source: OntologyObjectRef,
  linkId: string,
  scopeSortKey: string
): LinkScopeAccumulator {
  const hash = createHash("sha256")
  hash.update("[")
  return {
    scopeSortKey,
    source: structuredClone(source),
    linkId,
    hash,
    effectiveCount: 0,
  }
}

export function appendScopeSnapshot(
  accumulator: LinkScopeAccumulator,
  snapshot: EffectiveLinkSnapshot
): void {
  if (accumulator.effectiveCount > 0) accumulator.hash.update(",")
  accumulator.hash.update(
    stableJsonStringify({
      ref: snapshot.ref,
      properties: snapshot.properties ?? {},
      lastCommitId: snapshot.lastCommitId,
    })
  )
  accumulator.effectiveCount += 1
}

export function finishScopeAccumulator(
  accumulator: LinkScopeAccumulator
): MaterializationLinkScopeState {
  accumulator.hash.update("]")
  return {
    source: accumulator.source,
    linkId: accumulator.linkId,
    effectiveCount: accumulator.effectiveCount,
    fingerprint: accumulator.hash.digest("hex"),
  }
}

export interface ProviderReplacementSessionState {
  readonly sourceId: string
  readonly candidateMaterializationId: string
  readonly previousMaterializationId: string | null
  readonly projectionKind: "object" | "link"
  objectStreamStarted: boolean
  objectStreamCompleted: boolean
  linkStreamStarted: boolean
  linkStreamCompleted: boolean
}

export interface ProviderMaterializationLaneState {
  started: boolean
  completed: boolean
  emittedCount: number
}

export class ProviderMaterializationSessionState {
  readonly id = randomUUID()
  readonly providerToken = {}
  readonly workStreams: Record<
    StreamMaterializationWorkInput["order"],
    ProviderMaterializationLaneState
  > = {
    apply: { started: false, completed: false, emittedCount: 0 },
    cardinality: { started: false, completed: false, emittedCount: 0 },
    event: { started: false, completed: false, emittedCount: 0 },
  }
  active = true
  workSealed = false
  appliedPlanCount = 0
  appliedOutboxCount = 0
  replacement: ProviderReplacementSessionState | null = null

  constructor(
    readonly header: MaterializationPlanHeader,
    readonly transactionId: object
  ) {}

  publicSession(): MaterializationSession {
    return { providerToken: this.providerToken }
  }
}

/**
 * Tracks the materialization sessions owned by one storage transaction.
 *
 * Applying a chunk mutates authoritative tables before `finalize()` inserts the commit ledger row.
 * The transaction must therefore fail closed while any materialization session remains unfinished.
 */
export class ProviderMaterializationTransactionLifecycle {
  private readonly openSessions = new Set<object>()
  private active = true

  register(sessionToken: object): void {
    if (!this.active) {
      throw new MaterializationValidationError(
        "Cannot open a materialization session on an inactive storage transaction."
      )
    }
    this.openSessions.add(sessionToken)
  }

  complete(sessionToken: object): void {
    this.openSessions.delete(sessionToken)
  }

  assertCommittable(): void {
    if (this.openSessions.size === 0) return
    throw new MaterializationValidationError(
      `Storage transaction has ${this.openSessions.size} unfinished materialization session${
        this.openSessions.size === 1 ? "" : "s"
      }; every session returned by begin() must be finalized.`
    )
  }

  deactivate(): void {
    this.active = false
    this.openSessions.clear()
  }
}

export interface PreparedMaterializationWork {
  readonly record: MaterializationWorkRecord
  readonly uniqueKey: string
  readonly columns: ReturnType<typeof materializationWorkColumns>
}

export function prepareMaterializationWork(
  state: Pick<ProviderMaterializationSessionState, "header" | "workSealed" | "replacement">,
  input: StageMaterializationWorkInput
): readonly PreparedMaterializationWork[] {
  if (state.workSealed) {
    throw new MaterializationConflictError(
      "effective-state",
      "Materialization work cannot be staged after draining begins."
    )
  }
  const keys = new Set<string>()
  const uniqueKeys = new Set<string>()
  return input.records.map((record) => {
    assertWorkRecord(record, state.header)
    const uniqueKey = workUniquenessKey(record)
    if (keys.has(record.recordKey) || uniqueKeys.has(uniqueKey)) {
      throw duplicateMaterializationWork(record.recordKey)
    }
    if (
      record.kind === "incident-object" &&
      (!state.replacement || state.replacement.linkStreamStarted)
    ) {
      throw new MaterializationConflictError(
        "effective-state",
        "Incident replacement work must be staged before link state is streamed."
      )
    }
    keys.add(record.recordKey)
    uniqueKeys.add(uniqueKey)
    return { record, uniqueKey, columns: materializationWorkColumns(record) }
  })
}

export interface MaterializationChunkSequenceState {
  readonly workStreams: ProviderMaterializationSessionState["workStreams"]
  readonly appliedPlanCount: number
  readonly appliedOutboxCount: number
}

export function correlateMaterializationChunk(
  state: MaterializationChunkSequenceState,
  chunk: MaterializationPlanChunk,
  actualItems: readonly MaterializationPlanWorkItem[],
  expectedItems: readonly MaterializationPlanWorkItem[],
  expectedEvents: readonly MaterializationEventWorkRecord[]
): { readonly appliedPlanCount: number; readonly appliedOutboxCount: number } {
  if (
    actualItems.length > 0 &&
    (!state.workStreams.apply.started ||
      state.appliedPlanCount + actualItems.length > state.workStreams.apply.emittedCount)
  ) {
    invalidMaterializationCorrelation(
      "Materialization plan items cannot be applied before they are streamed."
    )
  }
  for (let index = 0; index < actualItems.length; index += 1) {
    if (stableJsonStringify(actualItems[index]) !== stableJsonStringify(expectedItems[index])) {
      invalidMaterializationCorrelation(
        "Materialization plan items must be applied in exact streamed order."
      )
    }
  }

  if (
    chunk.outbox.length > 0 &&
    (!state.workStreams.event.started ||
      state.appliedOutboxCount + chunk.outbox.length > state.workStreams.event.emittedCount)
  ) {
    invalidMaterializationCorrelation(
      "Materialization events cannot be applied before they are streamed."
    )
  }
  for (let index = 0; index < chunk.outbox.length; index += 1) {
    const expected = expectedEvents[index]
    const actual = chunk.outbox[index]?.envelope
    if (!expected || !actual) {
      invalidMaterializationCorrelation(
        "Materialization outbox events must follow exact streamed order."
      )
    }
    const { id: _id, commitOrdinal, ...draft } = actual
    if (
      commitOrdinal !== state.appliedOutboxCount + index ||
      stableJsonStringify(draft) !== stableJsonStringify(expected.draft)
    ) {
      invalidMaterializationCorrelation(
        "Materialization outbox events must follow exact streamed order."
      )
    }
  }
  return {
    appliedPlanCount: state.appliedPlanCount + actualItems.length,
    appliedOutboxCount: state.appliedOutboxCount + chunk.outbox.length,
  }
}

export function assertMaterializationFinalizationCorrelation(
  state: Pick<ProviderMaterializationSessionState, "header" | "appliedOutboxCount">,
  input: FinalizeMaterializationInput
): void {
  const { commit } = state.header
  const { result, sourceActivations } = input.finalization
  if (
    result.commitId !== commit.id ||
    result.kind !== commit.intent.kind ||
    result.created !== true ||
    !Number.isSafeInteger(result.eventCount) ||
    result.eventCount < 0 ||
    result.eventCount !== state.appliedOutboxCount
  ) {
    invalidMaterializationCorrelation(
      "Materialization result does not correlate with its commit intent."
    )
  }
  if (commit.intent.kind === "edit") {
    if (result.kind !== "edit" || result.outcomes.length !== commit.intent.operationCount) {
      invalidMaterializationCorrelation("Edit result does not correlate with its operation count.")
    }
    if (sourceActivations.length !== 0) {
      invalidMaterializationCorrelation(
        "Edit materialization cannot activate a source materialization."
      )
    }
  } else if (commit.intent.kind === "projection") {
    if (result.kind !== "projection" || sourceActivations.length !== 1) {
      invalidMaterializationCorrelation(
        "Projection result requires exactly one correlated source activation."
      )
    }
  } else if (result.kind !== "telemetry" || sourceActivations.length !== 0) {
    invalidMaterializationCorrelation("Telemetry result does not correlate with its point intent.")
  }
}

export function assertMaterializationLaneCompletion(
  state: Pick<
    ProviderMaterializationSessionState,
    "workStreams" | "appliedPlanCount" | "appliedOutboxCount"
  >,
  counts: { readonly apply: number; readonly cardinality: number; readonly event: number }
): void {
  if (counts.apply > 0 && !state.workStreams.apply.completed) {
    invalidMaterializationCorrelation("Materialization plan work was not fully streamed.")
  }
  if (state.appliedPlanCount !== counts.apply) {
    invalidMaterializationCorrelation("Materialization plan work was not applied exactly once.")
  }
  if (counts.cardinality > 0 && !state.workStreams.cardinality.completed) {
    invalidMaterializationCorrelation("Materialization cardinality work was not fully validated.")
  }
  if (counts.event > 0 && !state.workStreams.event.completed) {
    invalidMaterializationCorrelation("Materialization event work was not fully drained.")
  }
  if (counts.event !== state.appliedOutboxCount) {
    invalidMaterializationCorrelation(
      "Materialization event work was not fully written to the outbox."
    )
  }
}

export function assertSourceActivationCorrelation(
  state: Pick<ProviderMaterializationSessionState, "header" | "replacement">,
  activation: SourceActivationWrite
): void {
  const { commit } = state.header
  if (
    commit.intent.kind !== "projection" ||
    commit.origin.kind !== "projection" ||
    activation.source.projectionId !== commit.intent.source.projectionId ||
    activation.source.projectionId !== commit.origin.projectionId ||
    activation.execution.projectionRunId !== commit.origin.projectionRunId ||
    activation.protocol !== "replacement" ||
    stableJsonStringify(activation.datasetVersion) !==
      stableJsonStringify(commit.intent.datasetVersion) ||
    activation.projectionRevision !== commit.projectionRevision ||
    activation.ownershipHash !== commit.ownershipHash ||
    activation.ontologyRevision !== commit.ontologyRevision ||
    activation.lastCommitId !== commit.id ||
    activation.updatedAt !== commit.committedAt ||
    !state.header.expected.sources.some(
      (expected) => stableJsonStringify(expected) === stableJsonStringify(activation.expected)
    )
  ) {
    invalidMaterializationCorrelation(
      "Source activation does not correlate with its projection commit."
    )
  }
  const replacement = state.replacement
  if (
    !replacement ||
    replacement.sourceId !== activation.source.projectionId ||
    replacement.candidateMaterializationId !== activation.materializationId ||
    replacement.projectionKind !== activation.projectionKind ||
    (activation.projectionKind === "object" &&
      (!replacement.objectStreamCompleted || !replacement.linkStreamCompleted)) ||
    (activation.projectionKind === "link" && !replacement.linkStreamCompleted)
  ) {
    invalidMaterializationCorrelation(
      "Source activation does not match fully streamed replacement state."
    )
  }
}

function invalidMaterializationCorrelation(message: string): never {
  throw new MaterializationValidationError(message)
}

export function uniqueSorted<T>(
  values: readonly T[],
  identity: (value: T) => string,
  sortKey: (value: T) => string
): T[] {
  return [...new Map(values.map((value) => [identity(value), value])).values()].sort(
    (left, right) => sortKey(left).localeCompare(sortKey(right))
  )
}

export type OverrideEntity =
  | { readonly kind: "object"; readonly ref: OntologyObjectRef }
  | { readonly kind: "link"; readonly ref: OntologyLinkRef }

export function overrideEntityColumns(entity: OverrideEntity): {
  readonly sortKey: string
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
      sortKey: objectRefSortKey(entity.ref),
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
    sortKey: linkRefSortKey(entity.ref),
    objectTypeId: null,
    primaryId: null,
    sourceTypeId: entity.ref.source.objectTypeId,
    sourcePrimaryId: entity.ref.source.primaryId,
    linkId: entity.ref.linkId,
    targetTypeId: entity.ref.target.objectTypeId,
    targetPrimaryId: entity.ref.target.primaryId,
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

export function sourceEntityKey(row: StageSourceAssertion): string {
  return projectionEntityKey(row.assertion)
}

export interface SourceStageRow {
  readonly row: StageSourceAssertion
  readonly rootKey: string
  readonly entityKey: string
}

export interface ReconciledSourceStageRows {
  readonly pending: readonly SourceStageRow[]
  readonly unchanged: number
}

export function sourceStageRows(
  projectionKind: OntologySourceRecord["projectionKind"],
  rows: readonly StageSourceAssertion[]
): readonly SourceStageRow[] {
  return rows.map((row) => {
    assertSourceStagedRow(projectionKind, row)
    return sourceStageRow(row)
  })
}

export function sourceStageRow(row: StageSourceAssertion): SourceStageRow {
  return {
    row,
    rootKey: projectionEntityKey(row.root),
    entityKey: sourceEntityKey(row),
  }
}

export function reconcileSourceStageRows(
  rows: readonly SourceStageRow[],
  existingRows: readonly SourceStageRow[]
): ReconciledSourceStageRows {
  const rootOrdinals = new Map(
    existingRows.map(({ rootKey, row }) => [rootKey, row.stagingOrdinal] as const)
  )
  const ordinalRoots = new Map(
    existingRows.map(({ rootKey, row }) => [row.stagingOrdinal, rootKey] as const)
  )
  const assertions = new Map(existingRows.map((row) => [row.entityKey, row.row] as const))
  const pending = new Map<string, SourceStageRow>()
  let unchanged = 0

  for (const staged of rows) {
    const { entityKey, rootKey, row } = staged
    const rootOrdinal = rootOrdinals.get(rootKey)
    if (rootOrdinal !== undefined && rootOrdinal !== row.stagingOrdinal) {
      throw new MaterializationValidationError(
        `Source materialization repeats root ${rootKey} at a different stream ordinal.`
      )
    }
    const ordinalRoot = ordinalRoots.get(row.stagingOrdinal)
    if (ordinalRoot !== undefined && ordinalRoot !== rootKey) {
      throw new MaterializationValidationError(
        `Source materialization repeats stream ordinal ${row.stagingOrdinal} for another root.`
      )
    }

    const existing = assertions.get(entityKey) ?? pending.get(entityKey)?.row
    if (existing) {
      if (canonicalJson(existing) === canonicalJson(row)) {
        unchanged += 1
        continue
      }
      throw new MaterializationValidationError(
        `Source materialization repeats asserted entity ${entityKey}.`
      )
    }

    rootOrdinals.set(rootKey, row.stagingOrdinal)
    ordinalRoots.set(row.stagingOrdinal, rootKey)
    pending.set(entityKey, { ...staged, row: structuredClone(row) })
  }

  return { pending: [...pending.values()], unchanged }
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
