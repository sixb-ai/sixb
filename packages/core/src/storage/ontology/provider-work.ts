import { stableJsonStringify } from "../../json"
import { createEventId, materializationEventKindOrdinal } from "../../materialization/identity"
import type { OntologyLinkRef, OntologyObjectRef } from "../../materialization/model"
import {
  linkRefKey,
  linkRefSortKey,
  linkScopeSortKey,
  objectRefKey,
  telemetryPointKey,
} from "../../materialization/refs"
import {
  type ExactTimeseriesPointWrite,
  type MaterializationCardinalityOccupantWorkRecord,
  type MaterializationEventWorkRecord,
  type MaterializationPlanChunk,
  type MaterializationPlanHeader,
  type MaterializationPlanWorkItem,
  type MaterializationPlanWorkRecord,
  type MaterializationWorkRecord,
  materializationApplyPhase,
} from "./materializations"
import type { OntologyOutboxWrite } from "./outbox"
import { assertTimestamp, invalidCorrelation } from "./provider-validation"

export { invalidCorrelation } from "./provider-validation"

import { SixbError } from "../../errors"

export function assertPageRows(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new SixbError(
      "ontology.invalid_value",
      "[Sixb] Materialization page size must be positive."
    )
}

export function materializationChunkRows(chunk: MaterializationPlanChunk): number {
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
  chunk: MaterializationPlanChunk
): MaterializationPlanWorkItem[] {
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

export function assertWorkRecord(
  record: MaterializationWorkRecord,
  header: MaterializationPlanHeader
): void {
  if (record.recordKey.trim().length === 0) {
    throw new SixbError(
      "ontology.invalid_value",
      "[Sixb] Materialization work key must be nonblank."
    )
  }
  if (record.kind === "plan") {
    if (!/^[0-9a-f]+$/.test(record.sortKey) || !planPhaseMatches(record)) {
      throw new SixbError(
        "ontology.invalid_value",
        "[Sixb] Materialization plan work has an invalid order."
      )
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
      throw new SixbError("ontology.invalid_value", "[Sixb] Materialization event work is invalid.")
    }
    return
  }
  if (record.kind === "cardinality") {
    if (
      record.scopeSortKey !== linkScopeSortKey(record.ref.source, record.ref.linkId) ||
      record.linkSortKey !== linkRefSortKey(record.ref)
    ) {
      throw new SixbError(
        "ontology.invalid_value",
        "[Sixb] Materialization cardinality work has an invalid identity or order."
      )
    }
    return
  }
  if (record.kind === "classification" && record.identityKey.trim().length === 0) {
    throw new SixbError(
      "ontology.invalid_value",
      "[Sixb] Materialization classification identity is invalid."
    )
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

export function assertPlanChunkCorrelations(
  chunk: MaterializationPlanChunk,
  commit: MaterializationPlanHeader["commit"]
): void {
  // Physical writes correlate through the same per-item rule the work stream validates, so the two
  // paths stay in lockstep. Outbox writes are not plan items and keep their dedicated correlation.
  for (const item of materializationPlanItems(chunk)) assertPlanItemCorrelation(item, commit)
  for (const value of chunk.outbox) assertOutboxCorrelation(value, commit)
}

function assertPlanItemCorrelation(
  item: MaterializationPlanWorkItem,
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
  value: ExactTimeseriesPointWrite,
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
  value: OntologyOutboxWrite,
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
