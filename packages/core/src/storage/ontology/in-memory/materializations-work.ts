import { stableJsonStringify } from "../../../json"
import {
  MaterializationConflictError,
  MaterializationValidationError,
} from "../../../materialization/errors"
import { createEventId, materializationEventKindOrdinal } from "../../../materialization/identity"
import type { OntologyLinkRef, OntologyObjectRef } from "../../../materialization/model"
import {
  linkRefKey,
  linkRefSortKey,
  linkScopeSortKey,
  objectRefKey,
  telemetryPointKey,
} from "../../../materialization/refs"
import {
  type MaterializationCardinalityOccupantWorkRecord,
  type MaterializationEventWorkRecord,
  type MaterializationPlanHeader,
  type MaterializationPlanWorkItem,
  type MaterializationPlanWorkRecord,
  type MaterializationWorkRecord,
  materializationApplyPhase,
  type StoredLinkOverride,
  type StoredObjectOverride,
} from "../materializations"
import type { SessionState } from "./materializations"
import { assertNonblank, assertTimestamp } from "./shared-state"

export function invalidCorrelation(message: string): never {
  throw new MaterializationValidationError(message)
}

export function assertPageRows(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new MaterializationValidationError("Materialization page size must be positive.")
}

export function materializationChunkRows(
  chunk: import("../materializations").MaterializationPlanChunk
): number {
  return (
    chunk.overrides.objectUpserts.length +
    chunk.overrides.objectDeletes.length +
    chunk.overrides.linkUpserts.length +
    chunk.overrides.linkDeletes.length +
    chunk.effective.objectUpserts.length +
    chunk.effective.objectDeletes.length +
    chunk.effective.linkUpserts.length +
    chunk.effective.linkDeletes.length +
    chunk.timeseries.pointUpserts.length +
    chunk.outbox.length
  )
}

export function materializationPlanItems(
  chunk: import("../materializations").MaterializationPlanChunk
): import("../materializations").MaterializationPlanWorkItem[] {
  return [
    ...chunk.overrides.objectUpserts.map((value) => ({
      kind: "object-override-upsert" as const,
      value,
    })),
    ...chunk.overrides.objectDeletes.map((value) => ({
      kind: "object-override-delete" as const,
      value,
    })),
    ...chunk.overrides.linkUpserts.map((value) => ({
      kind: "link-override-upsert" as const,
      value,
    })),
    ...chunk.overrides.linkDeletes.map((value) => ({
      kind: "link-override-delete" as const,
      value,
    })),
    ...chunk.effective.linkDeletes.map((value) => ({ kind: "link-delete" as const, value })),
    ...chunk.effective.objectDeletes.map((value) => ({ kind: "object-delete" as const, value })),
    ...chunk.effective.objectUpserts.map((value) => ({ kind: "object-upsert" as const, value })),
    ...chunk.effective.linkUpserts.map((value) => ({ kind: "link-upsert" as const, value })),
    ...chunk.timeseries.pointUpserts.map((value) => ({ kind: "point-upsert" as const, value })),
  ]
}

export function assertChunkSequence(
  session: SessionState,
  chunk: import("../materializations").MaterializationPlanChunk
): void {
  const planItems = materializationPlanItems(chunk)
  const applyStream = session.workStreams.apply
  const appliedStart = session.appliedPlanItems.length
  if (
    planItems.length > 0 &&
    (!applyStream.started || appliedStart + planItems.length > applyStream.emittedCount)
  ) {
    invalidCorrelation("Materialization plan items cannot be applied before they are streamed.")
  }
  for (let offset = 0; offset < planItems.length; offset += 1) {
    const expected = session.applyWork[appliedStart + offset]?.item
    if (!expected || stableJsonStringify(planItems[offset]) !== stableJsonStringify(expected)) {
      invalidCorrelation("Materialization plan items must be applied in exact streamed order.")
    }
  }

  const eventStream = session.workStreams.event
  const appliedOutboxCount = session.outboxEnvelopes.size
  if (
    chunk.outbox.length > 0 &&
    (!eventStream.started || appliedOutboxCount + chunk.outbox.length > eventStream.emittedCount)
  ) {
    invalidCorrelation("Materialization events cannot be applied before they are streamed.")
  }
  for (let offset = 0; offset < chunk.outbox.length; offset += 1) {
    const expected = session.eventWork[appliedOutboxCount + offset]
    const actual = chunk.outbox[offset]?.envelope
    if (!expected || !actual) {
      invalidCorrelation("Materialization outbox events must follow exact streamed order.")
    }
    const { id: _id, commitOrdinal, ...actualDraft } = actual
    if (
      commitOrdinal !== appliedOutboxCount + offset ||
      stableJsonStringify(actualDraft) !== stableJsonStringify(expected.draft)
    ) {
      invalidCorrelation("Materialization outbox events must follow exact streamed order.")
    }
  }
}

export function assertLastCommit(
  value: StoredObjectOverride | StoredLinkOverride | undefined,
  expected: string | null,
  label: string
): void {
  if ((value?.lastCommitId ?? null) !== expected)
    throw new MaterializationConflictError("effective-state", `Expected ${label} changed.`)
}

export function assertWorkRecord(
  record: MaterializationWorkRecord,
  header: MaterializationPlanHeader
): void {
  if (record.recordKey.trim().length === 0) {
    throw new MaterializationValidationError("Materialization work key must be nonblank.")
  }
  if (record.kind === "plan") {
    if (!/^[0-9a-f]+$/.test(record.sortKey) || !planPhaseMatches(record)) {
      throw new MaterializationValidationError("Materialization plan work has an invalid order.")
    }
    assertPlanItemCorrelation(record.item, header.commit)
    return
  }
  if (record.kind === "event") {
    if (
      !/^[0-9a-f]+$/.test(record.sortKey) ||
      !Number.isSafeInteger(record.eventKindRank) ||
      record.eventKindRank < 0 ||
      record.eventKindRank !== materializationEventKindOrdinal(record.draft.type) ||
      record.draft.projectId !== header.commit.projectId ||
      record.draft.commitId !== header.commit.id ||
      record.draft.occurredAt !== header.commit.committedAt ||
      stableJsonStringify(record.draft.origin) !== stableJsonStringify(header.commit.origin) ||
      stableJsonStringify(record.draft.actor ?? null) !==
        stableJsonStringify(header.commit.actor ?? null)
    ) {
      throw new MaterializationValidationError("Materialization event work is invalid.")
    }
    return
  }
  if (record.kind === "cardinality") {
    if (
      record.scopeSortKey !== linkScopeSortKey(record.ref.source, record.ref.linkId) ||
      record.linkSortKey !== linkRefSortKey(record.ref)
    ) {
      throw new MaterializationValidationError(
        "Materialization cardinality work has an invalid identity or order."
      )
    }
    return
  }
  if (record.kind === "classification" && record.identityKey.trim().length === 0) {
    throw new MaterializationValidationError("Materialization classification identity is invalid.")
  }
}

export function workUniquenessKey(record: MaterializationWorkRecord): string {
  switch (record.kind) {
    case "classification":
      return `classification:${record.entityKind}:${record.identityKey}`
    case "object-existence":
      return `object-existence:${objectRefKey(record.ref)}`
    case "incident-object":
      return `incident-object:${objectRefKey(record.ref)}`
    case "cardinality":
      return `cardinality:${record.scopeSortKey}:${record.linkSortKey}`
    case "plan":
      return `plan:${record.item.kind}:${record.sortKey}`
    case "event":
      return `event:${record.eventKindRank}:${record.sortKey}`
  }
}

export function comparePlanWork(
  left: MaterializationPlanWorkRecord,
  right: MaterializationPlanWorkRecord
): number {
  return (
    left.applyPhase - right.applyPhase ||
    planKindOrder(left.item.kind) - planKindOrder(right.item.kind) ||
    left.sortKey.localeCompare(right.sortKey) ||
    left.recordKey.localeCompare(right.recordKey)
  )
}

function planKindOrder(kind: MaterializationPlanWorkItem["kind"]): number {
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

export function compareCardinalityWork(
  left: MaterializationCardinalityOccupantWorkRecord,
  right: MaterializationCardinalityOccupantWorkRecord
): number {
  return (
    left.scopeSortKey.localeCompare(right.scopeSortKey) ||
    left.linkSortKey.localeCompare(right.linkSortKey) ||
    left.recordKey.localeCompare(right.recordKey)
  )
}

export function compareEventWork(
  left: MaterializationEventWorkRecord,
  right: MaterializationEventWorkRecord
): number {
  return (
    left.eventKindRank - right.eventKindRank ||
    left.sortKey.localeCompare(right.sortKey) ||
    left.recordKey.localeCompare(right.recordKey)
  )
}

function planPhaseMatches(record: MaterializationPlanWorkRecord): boolean {
  // Validate the submitted phase against the neutral contract's canonical mapping so a provider
  // still rejects a mis-ordered record without re-encoding the phase table here.
  return record.applyPhase === materializationApplyPhase(record.item.kind)
}

export function assertMaterializationHeader(header: MaterializationPlanHeader): void {
  const { commit } = header
  assertNonblank(commit.projectId, "Materialization project id")
  assertNonblank(commit.id, "Materialization commit id")
  assertNonblank(commit.idempotencyKey, "Materialization idempotency key")
  assertNonblank(commit.requestHash, "Materialization request hash")
  assertNonblank(commit.ontologyRevision, "Materialization ontology revision")
  assertTimestamp(commit.committedAt, "Materialization commit time")
  if (commit.intent.kind === "edit") {
    if (commit.origin.kind !== "action" && commit.origin.kind !== "runtime") {
      invalidCorrelation("Edit commit origin does not correlate with its intent.")
    }
    if (!Number.isSafeInteger(commit.intent.operationCount) || commit.intent.operationCount < 0) {
      invalidCorrelation("Edit commit operation count is invalid.")
    }
    if (commit.origin.kind === "action") {
      assertNonblank(commit.origin.actionId, "Action origin action id")
      assertNonblank(commit.origin.runId, "Action origin run id")
    } else {
      assertNonblank(commit.origin.requestId, "Runtime origin request id")
    }
  } else if (commit.intent.kind === "projection") {
    if (
      commit.origin.kind !== "projection" ||
      commit.origin.projectionId !== commit.intent.source.projectionId ||
      commit.origin.datasetId !== commit.intent.datasetVersion.datasetId ||
      commit.origin.datasetVersionId !== commit.intent.datasetVersion.versionId ||
      !commit.projectionRevision ||
      !commit.ownershipHash
    ) {
      invalidCorrelation("Projection commit metadata does not correlate with its intent.")
    }
    assertNonblank(commit.origin.projectionRunId, "Projection run id")
    assertTimestamp(commit.intent.datasetVersion.createdAt, "Projection dataset version createdAt")
  } else {
    if (commit.origin.kind !== "telemetry") {
      invalidCorrelation("Telemetry commit origin does not correlate with its intent.")
    }
    if (
      !Number.isSafeInteger(commit.intent.pointCount) ||
      commit.intent.pointCount < 0 ||
      !Number.isSafeInteger(commit.intent.inputPointCount) ||
      commit.intent.inputPointCount < commit.intent.pointCount
    ) {
      invalidCorrelation("Telemetry commit point counts are invalid.")
    }
    if (commit.intent.source.kind === "projection") {
      if (
        commit.origin.source.kind !== "projection" ||
        commit.intent.source.projection.projectionId !== commit.origin.source.projectionId ||
        commit.intent.source.datasetVersion.datasetId !== commit.origin.source.datasetId ||
        commit.intent.source.datasetVersion.versionId !== commit.origin.source.datasetVersionId ||
        commit.intent.source.batchOrdinal !== commit.origin.source.batchOrdinal ||
        !Number.isSafeInteger(commit.intent.source.batchOrdinal) ||
        commit.intent.source.batchOrdinal < 0 ||
        !Number.isSafeInteger(commit.intent.source.sourceRowCount) ||
        commit.intent.source.sourceRowCount <= 0 ||
        commit.intent.source.sourceRowCount < commit.intent.inputPointCount ||
        typeof commit.intent.source.inputExhausted !== "boolean" ||
        !commit.projectionRevision ||
        !commit.ownershipHash
      ) {
        invalidCorrelation("Projection telemetry metadata does not correlate with its intent.")
      }
      assertNonblank(commit.origin.source.projectionRunId, "Telemetry projection run id")
      assertTimestamp(
        commit.intent.source.datasetVersion.createdAt,
        "Telemetry dataset version createdAt"
      )
    } else if (
      commit.origin.source.kind !== "runtime" ||
      commit.projectionRevision !== undefined ||
      commit.ownershipHash !== undefined
    ) {
      invalidCorrelation("Runtime telemetry commit contains projection-only metadata.")
    }
  }
}

export function assertPlanChunkCorrelations(
  chunk: import("../materializations").MaterializationPlanChunk,
  commit: MaterializationPlanHeader["commit"]
): void {
  // Physical writes correlate through the same per-item rule the work stream validates, so the two
  // paths stay in lockstep. Outbox writes are not plan items and keep their dedicated correlation.
  for (const item of materializationPlanItems(chunk)) assertPlanItemCorrelation(item, commit)
  for (const value of chunk.outbox) assertOutboxCorrelation(value, commit)
}

function assertPlanItemCorrelation(
  item: import("../materializations").MaterializationPlanWorkItem,
  commit: MaterializationPlanHeader["commit"]
): void {
  switch (item.kind) {
    case "object-override-upsert":
      assertCommitWriteCorrelation(
        item.value.lastCommitId,
        item.value.updatedAt,
        commit,
        "Object override"
      )
      return
    case "object-override-delete":
      return
    case "link-override-upsert":
      assertCommitWriteCorrelation(
        item.value.lastCommitId,
        item.value.updatedAt,
        commit,
        "Link override"
      )
      return
    case "link-override-delete":
      return
    case "object-upsert":
      assertObjectRefEqual(item.value.row.ref, item.value.expected.ref, "Effective object upsert")
      assertCommitWriteCorrelation(
        item.value.row.lastCommitId,
        item.value.row.updatedAt,
        commit,
        "Effective object"
      )
      return
    case "object-delete":
      assertObjectRefEqual(item.value.ref, item.value.expected.ref, "Effective object delete")
      return
    case "link-upsert":
      assertLinkRefEqual(item.value.row.ref, item.value.expected.ref, "Effective link upsert")
      assertCommitWriteCorrelation(
        item.value.row.lastCommitId,
        item.value.row.updatedAt,
        commit,
        "Effective link"
      )
      return
    case "link-delete":
      assertLinkRefEqual(item.value.ref, item.value.expected.ref, "Effective link delete")
      return
    case "point-upsert":
      assertPointWriteCorrelation(item.value, commit)
      return
  }
}

function assertPointWriteCorrelation(
  value: import("../materializations").ExactTimeseriesPointWrite,
  commit: MaterializationPlanHeader["commit"]
): void {
  if (
    telemetryPointKey(value.point.series, value.point.at) !==
    telemetryPointKey(value.expected.series, value.expected.at)
  ) {
    invalidCorrelation("Timeseries point write does not match its expected identity.")
  }
  assertTimestamp(value.point.at, "Timeseries point timestamp")
  if (value.point.lastCommitId !== commit.id) {
    invalidCorrelation("Timeseries point last commit id does not match its session commit.")
  }
}

function assertOutboxCorrelation(
  value: import("../outbox").OntologyOutboxWrite,
  commit: MaterializationPlanHeader["commit"]
): void {
  const { envelope } = value
  if (
    envelope.projectId !== commit.projectId ||
    envelope.commitId !== commit.id ||
    envelope.occurredAt !== commit.committedAt ||
    value.availableAt !== commit.committedAt ||
    value.createdAt !== commit.committedAt ||
    stableJsonStringify(envelope.origin) !== stableJsonStringify(commit.origin) ||
    stableJsonStringify(envelope.actor ?? null) !== stableJsonStringify(commit.actor ?? null) ||
    !Number.isSafeInteger(envelope.commitOrdinal) ||
    envelope.commitOrdinal < 0 ||
    envelope.id !== createEventId(commit.projectId, commit.id, envelope.commitOrdinal)
  ) {
    invalidCorrelation("Outbox event does not correlate with its materialization commit.")
  }
}

function assertCommitWriteCorrelation(
  lastCommitId: string,
  updatedAt: string,
  commit: MaterializationPlanHeader["commit"],
  label: string
): void {
  if (lastCommitId !== commit.id || updatedAt !== commit.committedAt) {
    invalidCorrelation(`${label} provenance does not match its session commit.`)
  }
}

function assertObjectRefEqual(
  left: OntologyObjectRef,
  right: OntologyObjectRef,
  label: string
): void {
  if (objectRefKey(left) !== objectRefKey(right)) {
    invalidCorrelation(`${label} row and expected references differ.`)
  }
}

function assertLinkRefEqual(left: OntologyLinkRef, right: OntologyLinkRef, label: string): void {
  if (linkRefKey(left) !== linkRefKey(right)) {
    invalidCorrelation(`${label} row and expected references differ.`)
  }
}
