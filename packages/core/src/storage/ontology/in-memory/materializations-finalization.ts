import { stableJsonStringify } from "../../../json"
import { assertPinnedDatasetWatermark } from "../../../materialization/dataset-watermark"
import { MaterializationConflictError } from "../../../materialization/errors"
import { createEventId } from "../../../materialization/identity"
import type {
  EffectiveChangeCounts,
  OntologyObjectRef,
  PinnedDatasetVersion,
  TelemetryCommitResult,
} from "../../../materialization/model"
import { linkRefKey, linkRefSortKey, objectRefKey } from "../../../materialization/refs"
import {
  getInMemoryObjectMaterializerAdapter,
  type InMemoryObjectStorage,
} from "../../objects/in-memory"
import type { MaterializationCardinalityOccupantWorkRecord } from "../materializations"
import type { SessionState } from "./materializations"
import { findActiveSourceMaterialization, linkRef } from "./materializations-state"
import { compareEventWork, invalidCorrelation } from "./materializations-work"
import { type InMemoryOntologyState, outboxKey, sourceMaterializationKey } from "./shared-state"

export function assertFinalizationCorrelations(
  session: SessionState,
  finalization: import("../materializations").MaterializationPlanFinalization,
  state: InMemoryOntologyState,
  objects: InMemoryObjectStorage
): void {
  const { commit } = session.header
  const { result, sourceActivations } = finalization
  if (
    result.commitId !== commit.id ||
    result.kind !== commit.intent.kind ||
    result.committedAt !== commit.committedAt ||
    result.created !== true ||
    !Number.isSafeInteger(result.eventCount) ||
    result.eventCount < 0 ||
    result.eventCount !== session.outboxEnvelopes.size
  ) {
    invalidCorrelation("Materialization result does not correlate with its commit intent.")
  }
  for (let ordinal = 0; ordinal < result.eventCount; ordinal += 1) {
    if (!session.outboxEnvelopes.has(ordinal)) {
      invalidCorrelation("Outbox event ordinals must be contiguous from zero.")
    }
  }

  if (commit.intent.kind === "edit") {
    if (result.kind !== "edit" || result.outcomes.length !== commit.intent.operationCount) {
      invalidCorrelation("Edit result does not correlate with its operation count.")
    }
    if (sourceActivations.length !== 0) {
      invalidCorrelation("Edit materialization cannot activate a source materialization.")
    }
  } else if (commit.intent.kind === "projection") {
    if (result.kind !== "projection" || sourceActivations.length !== 1) {
      invalidCorrelation("Projection result requires exactly one correlated source activation.")
    }
  } else if (result.kind !== "telemetry" || sourceActivations.length !== 0) {
    invalidCorrelation("Telemetry result does not correlate with its point intent.")
  }

  for (const activation of sourceActivations) {
    assertSourceActivationCorrelation(activation, session, state)
  }
  if (sourceActivations[0]) {
    assertPlanCoverage(session, sourceActivations[0])
  }
  assertFinalizedWork(session, state, objects)
  if (commit.intent.kind === "projection") {
    if (result.kind !== "projection" || !projectionCountsCorrelate(session, result.counts)) {
      invalidCorrelation("Projection result counts do not correlate with finalized work.")
    }
  } else if (
    commit.intent.kind === "telemetry" &&
    (result.kind !== "telemetry" ||
      !telemetryCountsCorrelate(session, commit.intent.pointCount, result))
  ) {
    invalidCorrelation("Telemetry result counts do not correlate with finalized work.")
  }
}

function projectionCountsCorrelate(session: SessionState, actual: EffectiveChangeCounts): boolean {
  const expected = deriveExpectedProjectionCounts(session)
  if (expected === null) return false

  return effectiveChangeCountsMatch(actual, expected)
}

interface ClassifiedProjectionCounts {
  objects: number
  links: number
}

interface AppliedProjectionChangeCounts {
  objectsCreated: number
  objectsUpdated: number
  objectsDeleted: number
  linksCreated: number
  linksUpdated: number
  linksDeleted: number
}

const effectiveChangeCountKeys = [
  "objectsCreated",
  "objectsUpdated",
  "objectsDeleted",
  "objectsUnchanged",
  "linksCreated",
  "linksUpdated",
  "linksDeleted",
  "linksUnchanged",
] as const satisfies readonly (keyof EffectiveChangeCounts)[]

function deriveExpectedProjectionCounts(session: SessionState): EffectiveChangeCounts | null {
  const classified = countClassifiedProjectionEntities(session)
  const applied = countAppliedProjectionChanges(session)
  const objectsUnchanged = remainingClassifiedCount(
    classified.objects,
    applied.objectsCreated,
    applied.objectsUpdated,
    applied.objectsDeleted
  )
  const linksUnchanged = remainingClassifiedCount(
    classified.links,
    applied.linksCreated,
    applied.linksUpdated,
    applied.linksDeleted
  )

  if (objectsUnchanged < 0 || linksUnchanged < 0) return null

  return { ...applied, objectsUnchanged, linksUnchanged }
}

function countClassifiedProjectionEntities(session: SessionState): ClassifiedProjectionCounts {
  const counts = { objects: 0, links: 0 }

  for (const record of session.work.values()) {
    if (record.kind !== "classification") continue

    if (record.entityKind === "object") counts.objects += 1
    if (record.entityKind === "link") counts.links += 1
  }

  return counts
}

function countAppliedProjectionChanges(session: SessionState): AppliedProjectionChangeCounts {
  const counts: AppliedProjectionChangeCounts = {
    objectsCreated: 0,
    objectsUpdated: 0,
    objectsDeleted: 0,
    linksCreated: 0,
    linksUpdated: 0,
    linksDeleted: 0,
  }

  for (const work of session.applyWork) {
    const { item } = work

    switch (item.kind) {
      case "object-upsert":
        if (item.value.expected.exists) counts.objectsUpdated += 1
        else counts.objectsCreated += 1
        break
      case "object-delete":
        counts.objectsDeleted += 1
        break
      case "link-upsert":
        if (item.value.expected.exists) counts.linksUpdated += 1
        else counts.linksCreated += 1
        break
      case "link-delete":
        counts.linksDeleted += 1
        break
    }
  }

  return counts
}

function remainingClassifiedCount(
  classified: number,
  created: number,
  updated: number,
  deleted: number
): number {
  return classified - created - updated - deleted
}

function effectiveChangeCountsMatch(
  actual: EffectiveChangeCounts,
  expected: EffectiveChangeCounts
): boolean {
  return effectiveChangeCountKeys.every((key) => {
    const count = actual[key]
    return Number.isSafeInteger(count) && count >= 0 && count === expected[key]
  })
}

function telemetryCountsCorrelate(
  session: SessionState,
  pointCount: number,
  actual: TelemetryCommitResult
): boolean {
  let pointsCreated = 0
  let pointsUpdated = 0
  let latestObjectsChanged = 0
  for (const work of session.applyWork) {
    if (work.item.kind === "point-upsert") {
      if (work.item.value.expected.lastCommitId === null) pointsCreated += 1
      else pointsUpdated += 1
    } else if (work.item.kind === "object-upsert") {
      latestObjectsChanged += 1
    }
  }
  const expected = {
    pointsCreated,
    pointsUpdated,
    pointsUnchanged: pointCount - pointsCreated - pointsUpdated,
    latestObjectsChanged,
  }
  return (
    expected.pointsUnchanged >= 0 &&
    (Object.keys(expected) as (keyof typeof expected)[]).every(
      (key) =>
        Number.isSafeInteger(actual[key]) && actual[key] >= 0 && actual[key] === expected[key]
    )
  )
}

function assertSourceActivationCorrelation(
  activation: import("../materializations").SourceActivationWrite,
  session: SessionState,
  state: InMemoryOntologyState
): void {
  const { header } = session
  const { commit } = header
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
    !header.expected.sources.some(
      (expected) => stableJsonStringify(expected) === stableJsonStringify(activation.expected)
    )
  ) {
    invalidCorrelation("Source activation does not correlate with its projection commit.")
  }
  const candidate = state.sourceMaterializations.get(
    sourceMaterializationKey(
      commit.projectId,
      activation.source.projectionId,
      activation.materializationId
    )
  )
  if (!candidate || candidate.status !== "ready") {
    throw new MaterializationConflictError(
      "source-materialization",
      "Source activation candidate is missing or is not ready."
    )
  }
  if (
    candidate.projectionRunId !== activation.execution.projectionRunId ||
    candidate.executionToken !== activation.execution.executionToken ||
    candidate.projectionKind !== activation.projectionKind ||
    candidate.protocol !== activation.protocol ||
    stableJsonStringify(candidate.datasetVersion) !==
      stableJsonStringify(activation.datasetVersion) ||
    candidate.projectionRevision !== activation.projectionRevision ||
    candidate.ownershipHash !== activation.ownershipHash ||
    candidate.ontologyRevision !== activation.ontologyRevision
  ) {
    invalidCorrelation("Source activation does not match its ready candidate identity.")
  }
  if (candidate.readyAt === null) {
    invalidCorrelation("Source activation candidate has no ready timestamp.")
  }
  assertTimestampNotBefore(
    activation.updatedAt,
    candidate.readyAt,
    "Source activation cannot precede candidate readiness."
  )
  const previous = findActiveSourceMaterialization(
    state,
    commit.projectId,
    activation.source.projectionId
  )
  if (previous) {
    assertSourceDatasetWatermark(previous.datasetVersion, activation.datasetVersion)
    assertTimestampNotBefore(
      activation.updatedAt,
      previous.updatedAt,
      "Source activation cannot precede the active materialization update."
    )
  }
}

function assertSourceDatasetWatermark(
  active: PinnedDatasetVersion,
  next: PinnedDatasetVersion
): void {
  assertPinnedDatasetWatermark(active, next, "Source activation")
}

function assertFinalizedWork(
  session: SessionState,
  state: InMemoryOntologyState,
  objects: InMemoryObjectStorage
): void {
  if (!session.applied) {
    invalidCorrelation("A materialization plan must apply before it finalizes.")
  }
  assertFinalCardinality(session.cardinalityWork, session.header.commit.projectId, objects)
  if (session.header.commit.intent.kind === "telemetry") {
    const pointKeys = classificationKeys(session, "point")
    if (pointKeys.length !== session.header.commit.intent.pointCount) {
      invalidCorrelation(
        "Telemetry point classification coverage does not match the commit intent."
      )
    }
  }

  const expectedEvents = [...session.eventWork].sort(compareEventWork)
  if (session.outboxEnvelopes.size !== expectedEvents.length) {
    invalidCorrelation("Materialization event work was not fully written to the outbox.")
  }
  for (let ordinal = 0; ordinal < expectedEvents.length; ordinal += 1) {
    const expected = expectedEvents[ordinal]
    const actual = session.outboxEnvelopes.get(ordinal)
    if (!expected || !actual) {
      invalidCorrelation("Materialization event work was not fully written to the outbox.")
    }
    const { id, commitOrdinal, ...actualDraft } = actual
    if (
      commitOrdinal !== ordinal ||
      id !== createEventId(session.header.commit.projectId, session.header.commit.id, ordinal) ||
      stableJsonStringify(actualDraft) !== stableJsonStringify(expected.draft)
    ) {
      invalidCorrelation("Materialization outbox event does not match its staged event work.")
    }
    const persisted = state.outbox.get(outboxKey(session.header.commit.projectId, actual.id))
    if (!persisted || stableJsonStringify(persisted.envelope) !== stableJsonStringify(actual)) {
      invalidCorrelation("Materialization outbox event was not persisted.")
    }
  }
}

function assertFinalCardinality(
  records: readonly MaterializationCardinalityOccupantWorkRecord[],
  projectId: string,
  objects: InMemoryObjectStorage
): void {
  const effectiveOccupants = records.filter((record) => record.view === "effective")
  const scopes = new Map<
    string,
    {
      readonly source: OntologyObjectRef
      readonly linkId: string
      readonly occupiedLinkKeys: Set<string>
    }
  >()
  // Apply already rejected a scope with two staged occupants; this checks what it wrote.
  for (const record of effectiveOccupants) {
    const scope = scopes.get(record.scopeSortKey) ?? {
      source: structuredClone(record.ref.source),
      linkId: record.ref.linkId,
      occupiedLinkKeys: new Set<string>(),
    }
    scopes.set(record.scopeSortKey, scope)
    if (record.occupied) scope.occupiedLinkKeys.add(record.linkSortKey)
  }

  const adapter = getInMemoryObjectMaterializerAdapter(objects)
  for (const scope of scopes.values()) {
    const effectiveLinkKeys: string[] = []
    adapter.visitExactScopeLinks(
      projectId,
      scope.source.objectTypeId,
      scope.source.primaryId,
      scope.linkId,
      (row) => effectiveLinkKeys.push(linkRefSortKey(linkRef(row)))
    )
    effectiveLinkKeys.sort()
    const occupiedLinkKeys = [...scope.occupiedLinkKeys].sort()
    if (stableJsonStringify(effectiveLinkKeys) !== stableJsonStringify(occupiedLinkKeys)) {
      invalidCorrelation(
        "Materialization cardinality work does not match the final effective link scope."
      )
    }
  }
}

/** Every identity the plan decides with a diff is classified once, and nothing else is. */
function assertPlanCoverage(
  session: SessionState,
  activation: import("../materializations").SourceActivationWrite
): void {
  const plan = session.plan
  if (
    !plan ||
    plan.sourceId !== activation.source.projectionId ||
    plan.materializationId !== activation.materializationId ||
    plan.projectionKind !== activation.projectionKind
  ) {
    invalidCorrelation("Source activation does not match the replacement plan the session applies.")
  }
  const expected = (kind: "object" | "link") =>
    [...plan.identities.values()]
      .filter((identity) => identity.entity.kind === kind && identity.diffRequired)
      .map((identity) =>
        identity.entity.kind === "object"
          ? objectRefKey(identity.entity.ref)
          : linkRefKey(identity.entity.ref)
      )
      .sort()
  if (
    stableJsonStringify(classificationKeys(session, "object")) !==
      stableJsonStringify(expected("object")) ||
    stableJsonStringify(classificationKeys(session, "link")) !==
      stableJsonStringify(expected("link")) ||
    classificationKeys(session, "point").length > 0
  ) {
    invalidCorrelation("Projection replacement classification coverage does not match its plan.")
  }
}

function classificationKeys(
  session: SessionState,
  entityKind: import("../materializations").MaterializationWorkEntityKind
): string[] {
  return [...session.work.values()]
    .filter(
      (record): record is import("../materializations").MaterializationClassificationWorkRecord =>
        record.kind === "classification" && record.entityKind === entityKind
    )
    .map((record) => record.identityKey)
    .sort()
}

function assertTimestampNotBefore(value: string, minimum: string, message: string): void {
  if (Date.parse(value) < Date.parse(minimum)) invalidCorrelation(message)
}
