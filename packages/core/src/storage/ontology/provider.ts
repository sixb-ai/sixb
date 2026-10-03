import { createHash, randomUUID } from "node:crypto"
import { stableJsonStringify } from "../../json"
import {
  MaterializationConflictError,
  MaterializationValidationError,
} from "../../materialization/errors"
import type {
  EffectiveLinkSnapshot,
  ExpectedLinkRevision,
  ExpectedLinkScopeRevision,
  ExpectedObjectRevision,
  OntologyLinkRef,
  OntologyObjectRef,
  ProjectionEntityRef,
  ProjectionSourceAssertion,
} from "../../materialization/model"
import { linkRefKey, objectRefKey, projectionEntityKey } from "../../materialization/refs"
import type { OntologyCommitOriginSelector, OntologyCommitWrite } from "./commits"
import type {
  FinalizeMaterializationInput,
  MaterializationLinkScopeRevision,
  MaterializationPlanHeader,
  MaterializationSession,
  MaterializationWorkRecord,
  SourceActivationWrite,
  StageMaterializationWorkInput,
  StoredLinkSlotOverride,
} from "./materializations"
import { assertNonblank, assertTimestamp } from "./provider-validation"
import { assertWorkRecord, materializationPlanKindRank, workUniquenessKey } from "./provider-work"
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

export { materializationApplyPhase } from "./materializations"
export { assertMaterializationHeader } from "./provider-header-validation"
export {
  assertNonblank,
  assertNonnegativeInteger,
  assertPositiveInteger,
  assertTimestamp,
  invalidCorrelation,
} from "./provider-validation"
export {
  assertPageRows,
  assertReplacementPlanCommit,
  assertWorkRecord,
  type CardinalityValidator,
  cardinalityViolation,
  compareCardinalityWork,
  compareEventWork,
  comparePlanWork,
  createCardinalityValidator,
  type ExactEffectiveWrites,
  type ExactOverrideWrites,
  type ExactTimeseriesWrites,
  type MaterializationPlanChunk,
  materializationChunkRows,
  materializationOutboxWrite,
  materializationPlanChunk,
  materializationPlanKindRank,
  type PreparedReplacementIdentity,
  prepareReplacementIdentities,
  workUniquenessKey,
} from "./provider-work"

export interface LinkScopeAccumulator {
  readonly source: OntologyObjectRef
  readonly linkId: string
  readonly hash: ReturnType<typeof createHash>
  effectiveCount: number
}

export function startScopeAccumulator(
  source: OntologyObjectRef,
  linkId: string
): LinkScopeAccumulator {
  const hash = createHash("sha256")
  hash.update("[")
  return {
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
): MaterializationLinkScopeRevision {
  accumulator.hash.update("]")
  return {
    source: accumulator.source,
    linkId: accumulator.linkId,
    effectiveCount: accumulator.effectiveCount,
    fingerprint: accumulator.hash.digest("hex"),
  }
}

export function linkSlotOverrideValue(
  value: unknown,
  scopeLabel: string
): StoredLinkSlotOverride["value"] {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw invalidLinkSlotOverride(scopeLabel)
  }
  if (value.kind === "legacy-conflict") {
    return { kind: "legacy-conflict" }
  }
  if (
    (value.kind !== "set" && value.kind !== "clear") ||
    !isRecord(value.target) ||
    typeof value.target.objectTypeId !== "string" ||
    value.target.objectTypeId.trim().length === 0 ||
    typeof value.target.primaryId !== "string" ||
    value.target.primaryId.trim().length === 0
  ) {
    throw invalidLinkSlotOverride(scopeLabel)
  }
  const target = {
    objectTypeId: value.target.objectTypeId,
    primaryId: value.target.primaryId,
  }
  if (value.kind === "clear") return { kind: "clear", target }
  if (value.properties === undefined) return { kind: "set", target }
  if (!isJsonObject(value.properties)) throw invalidLinkSlotOverride(scopeLabel)
  return { kind: "set", target, properties: structuredClone(value.properties) }
}

function invalidLinkSlotOverride(scopeLabel: string): MaterializationConflictError {
  return new MaterializationConflictError(
    "effective-state",
    `Cardinality-one link slot ${scopeLabel} contains an invalid stored override.`
  )
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isJsonObject(
  value: unknown
): value is Readonly<Record<string, import("../../json").JsonValue>> {
  return isRecord(value) && Object.values(value).every(isJsonValue)
}

function isJsonValue(value: unknown): value is import("../../json").JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isRecord(value) && Object.values(value).every(isJsonValue)
}

export class ProviderMaterializationSessionState {
  readonly id = randomUUID()
  readonly providerToken = {}
  active = true
  /** Staging closes once vector changes stream or the plan applies. */
  workSealed = false
  vectorChangesStreamed = false
  applied = false
  appliedEventCount = 0

  constructor(
    readonly header: MaterializationPlanHeader,
    readonly transactionId: object
  ) {}

  publicSession(): MaterializationSession {
    return { providerToken: this.providerToken }
  }
}

/** Seals staging for the vector-change stream: once per session, before the plan applies. */
export function beginMaterializationVectorChanges(
  state: Pick<
    ProviderMaterializationSessionState,
    "workSealed" | "vectorChangesStreamed" | "applied"
  >
): void {
  if (state.vectorChangesStreamed || state.applied) {
    throw new MaterializationConflictError(
      "effective-state",
      "Materialization vector changes stream once per session, before the plan applies."
    )
  }
  state.vectorChangesStreamed = true
  state.workSealed = true
}

/** Seals staging for the apply step: once per session. */
export function beginMaterializationApply(
  state: Pick<ProviderMaterializationSessionState, "workSealed" | "applied">
): void {
  if (state.applied) {
    throw new MaterializationConflictError(
      "effective-state",
      "A materialization plan applies once per session."
    )
  }
  state.applied = true
  state.workSealed = true
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
  state: Pick<ProviderMaterializationSessionState, "header" | "workSealed">,
  input: StageMaterializationWorkInput
): readonly PreparedMaterializationWork[] {
  if (state.header.plan) {
    throw new MaterializationConflictError(
      "effective-state",
      "A plan-bound materialization session applies its plan and stages no work."
    )
  }
  if (state.workSealed) {
    throw new MaterializationConflictError(
      "effective-state",
      "Materialization work cannot be staged once vector changes stream or the plan applies."
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
    if (record.kind === "incident-object" || record.kind === "object-existence") {
      throw new MaterializationConflictError(
        "effective-state",
        "Replacement work is staged on a replacement plan, not on a session."
      )
    }
    keys.add(record.recordKey)
    uniqueKeys.add(uniqueKey)
    return { record, uniqueKey, columns: materializationWorkColumns(record) }
  })
}

export function assertMaterializationFinalizationCorrelation(
  state: Pick<ProviderMaterializationSessionState, "header" | "applied" | "appliedEventCount">,
  input: FinalizeMaterializationInput
): void {
  const { commit } = state.header
  const { result, sourceActivations } = input.finalization
  if (!state.applied) {
    invalidMaterializationCorrelation("A materialization plan must apply before it finalizes.")
  }
  if (
    result.commitId !== commit.id ||
    result.kind !== commit.intent.kind ||
    result.committedAt !== commit.committedAt ||
    result.created !== true ||
    !Number.isSafeInteger(result.eventCount) ||
    result.eventCount < 0 ||
    result.eventCount !== state.appliedEventCount
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

export function assertSourceActivationCorrelation(
  state: Pick<ProviderMaterializationSessionState, "header">,
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
  if (
    !state.header.plan ||
    state.header.plan.source.projectionId !== activation.source.projectionId ||
    state.header.plan.materializationId !== activation.materializationId
  ) {
    invalidMaterializationCorrelation(
      "Source activation does not match the replacement plan the session applies."
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

/**
 * Rejects a commit whose expected object no longer matches its current effective row.
 *
 * Every provider checks commit expectations through these helpers, so a failed expectation is always
 * the `expectation` conflict kind: an Action run reports exactly that kind as a read conflict.
 */
export function assertExpectedObjectRevision(
  current: { readonly version: number; readonly lastCommitId: string | null } | null,
  expected: ExpectedObjectRevision
): void {
  if (!expected.exists) {
    if (current) {
      throw expectationConflict(`Expected object ${objectRefKey(expected.ref)} to be absent.`)
    }
    return
  }
  if (
    !current ||
    current.version !== expected.version ||
    current.lastCommitId !== expected.lastCommitId
  ) {
    throw expectationConflict(`Expected object ${objectRefKey(expected.ref)} changed.`)
  }
}

/** `currentLastCommitId` is `undefined` when the link has no effective row. */
export function assertExpectedLinkRevision(
  currentLastCommitId: string | null | undefined,
  expected: ExpectedLinkRevision
): void {
  if (!expected.exists) {
    if (currentLastCommitId !== undefined) {
      throw expectationConflict(`Expected link ${linkRefKey(expected.ref)} to be absent.`)
    }
    return
  }
  if (currentLastCommitId === undefined || currentLastCommitId !== expected.lastCommitId) {
    throw expectationConflict(`Expected link ${linkRefKey(expected.ref)} changed.`)
  }
}

export function assertExpectedLinkScopeRevision(
  currentFingerprint: string | undefined,
  expected: ExpectedLinkScopeRevision
): void {
  if (currentFingerprint === expected.fingerprint) return
  throw expectationConflict(
    `Expected link scope changed for ${expected.source.objectTypeId}:${expected.source.primaryId}.${expected.linkId}.`
  )
}

function expectationConflict(message: string): MaterializationConflictError {
  return new MaterializationConflictError("expectation", message)
}

export function materializationWorkColumns(record: MaterializationWorkRecord): {
  readonly lane: "none" | "apply" | "cardinality" | "event"
  readonly majorOrder: number
  readonly minorOrder: number
  readonly sortOne: string
  readonly sortTwo: string
} {
  if (record.kind === "plan") {
    return {
      lane: "apply",
      majorOrder: record.applyPhase,
      minorOrder: materializationPlanKindRank(record.item.kind),
      sortOne: record.sortKey,
      sortTwo: "",
    }
  }
  if (record.kind === "cardinality") {
    return {
      lane: "cardinality",
      majorOrder: record.view === "effective" ? 0 : 1,
      minorOrder: 0,
      sortOne: record.scopeSortKey,
      sortTwo: record.linkSortKey,
    }
  }
  if (record.kind === "event") {
    return {
      lane: "event",
      majorOrder: record.eventKindRank,
      minorOrder: 0,
      sortOne: record.sortKey,
      sortTwo: "",
    }
  }
  return { lane: "none", majorOrder: 0, minorOrder: 0, sortOne: "", sortTwo: "" }
}

export function duplicateMaterializationWork(key?: string): MaterializationConflictError {
  return new MaterializationConflictError(
    "effective-state",
    key === undefined
      ? "Duplicate materialization work."
      : `Duplicate materialization work key '${key}'.`
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

export interface SourceStageRoot {
  readonly root: StageSourceAssertion["root"]
  readonly rootKey: string
  readonly stagingOrdinal: number
  readonly deleted: boolean
}

/** Shared root identity rules, including deletions that deliberately have no assertion rows. */
export function sourceStageRoots(
  projectionKind: OntologySourceRecord["projectionKind"],
  input: {
    readonly rows: readonly StageSourceAssertion[]
    readonly deletions?: readonly {
      readonly root: StageSourceAssertion["root"]
      readonly stagingOrdinal: number
    }[]
  }
): readonly SourceStageRoot[] {
  for (const row of input.rows) assertSourceStagedRow(projectionKind, row)
  const roots = new Map<string, SourceStageRoot>()
  const ordinals = new Map<number, string>()
  for (const [items, deleted] of [
    [input.rows, false],
    [input.deletions ?? [], true],
  ] as const) {
    for (const row of items) {
      assertSourceEntity(row.root, "Source root")
      if (
        row.root.kind !== projectionKind ||
        !Number.isSafeInteger(row.stagingOrdinal) ||
        row.stagingOrdinal < 0
      ) {
        throw new MaterializationValidationError("Source root kind or staging ordinal is invalid.")
      }
      const key = projectionEntityKey(row.root)
      const previous = roots.get(key)
      const otherRoot = ordinals.get(row.stagingOrdinal)
      if (
        (previous &&
          (previous.deleted !== deleted || previous.stagingOrdinal !== row.stagingOrdinal)) ||
        (otherRoot !== undefined && otherRoot !== key)
      ) {
        throw new MaterializationValidationError(
          `Source materialization repeats root or stream ordinal ${row.stagingOrdinal} with different content.`
        )
      }
      roots.set(key, {
        root: row.root,
        rootKey: key,
        stagingOrdinal: row.stagingOrdinal,
        deleted,
      })
      ordinals.set(row.stagingOrdinal, key)
    }
  }
  return [...roots.values()]
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
  if (input.base) {
    assertNonblank(input.base.materializationId, "Source base materialization id")
    assertNonblank(input.base.lastCommitId, "Source base commit id")
    if (input.base.materializationId === input.materializationId) {
      throw new MaterializationValidationError("A source candidate cannot be its own base.")
    }
  }
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

/** The inverse of `projectionEntityKey`, for providers that store only the canonical key. */
export function sourceEntityFromKey(key: string): ProjectionEntityRef {
  const parts: unknown = JSON.parse(key)
  if (Array.isArray(parts) && parts.every((part) => typeof part === "string")) {
    if (parts[0] === "object" && parts.length === 3) {
      return { kind: "object", ref: { objectTypeId: parts[1]!, primaryId: parts[2]! } }
    }
    if (parts[0] === "link" && parts.length === 6) {
      return {
        kind: "link",
        ref: {
          source: { objectTypeId: parts[1]!, primaryId: parts[2]! },
          linkId: parts[3]!,
          target: { objectTypeId: parts[4]!, primaryId: parts[5]! },
        },
      }
    }
  }
  throw new MaterializationConflictError(
    "source-materialization",
    `Stored source key ${key} is not a canonical entity key.`
  )
}

/** What an assertion carries beyond its identity, or null when that is nothing. */
export function sourceAssertionPayload(
  assertion: ProjectionSourceAssertion
): Readonly<Record<string, unknown>> | null {
  const { kind: _kind, ref: _ref, ...payload } = assertion
  return Object.keys(payload).length === 0 ? null : payload
}

/** Rebuilds an assertion from its typed identity columns and its payload. */
export function sourceAssertionFromColumns(
  columns: {
    readonly entity_kind: "object" | "link"
    readonly object_type_id: string | null
    readonly primary_id: string | null
    readonly source_type_id: string | null
    readonly source_primary_id: string | null
    readonly link_id: string | null
    readonly target_type_id: string | null
    readonly target_primary_id: string | null
  },
  payload: unknown
): ProjectionSourceAssertion {
  const rest = (payload ?? {}) as Record<string, unknown>
  if (columns.entity_kind === "object") {
    return {
      kind: "object",
      ref: { objectTypeId: columns.object_type_id!, primaryId: columns.primary_id! },
      ...rest,
    } as ProjectionSourceAssertion
  }
  return {
    kind: "link",
    ref: {
      source: { objectTypeId: columns.source_type_id!, primaryId: columns.source_primary_id! },
      linkId: columns.link_id!,
      target: { objectTypeId: columns.target_type_id!, primaryId: columns.target_primary_id! },
    },
    ...rest,
  } as ProjectionSourceAssertion
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
    row.base?.materializationId === input.base?.materializationId &&
    row.base?.lastCommitId === input.base?.lastCommitId &&
    row.ontologyRevision === input.ontologyRevision
  )
}

export function sourceConflict(message: string): MaterializationConflictError {
  return new MaterializationConflictError("source-materialization", message)
}
