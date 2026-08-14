import { stableJsonStringify } from "../../json"
import type { EffectiveLinkChange, EffectiveObjectChange } from "../../materialization/model"
import type {
  MaterializationClassificationWorkRecord,
  MaterializationEventWorkRecord,
  MaterializationPlanWorkItem,
  MaterializationPlanWorkRecord,
  MaterializationWorkEntityKind,
  OntologyMaterializationEvent,
  OntologyOutboxWrite,
} from "../../storage/ontology"
import { materializationApplyPhase } from "../../storage/ontology/materializations"
import type { WorkingLinkEdge, WorkingLinkSlot, WorkingObject } from "../edits/working-state"
import type { OrderedMaterializationEventDraft } from "../effective/build-events"
import type { TimedCommitIdentity } from "../shared/identity"
import type { MaterializationPlanItem } from "./plan-stream"

export function appendObjectOverrideWork(
  items: MaterializationPlanWorkItem[],
  working: WorkingObject,
  identity: TimedCommitIdentity
): void {
  if (
    stableJsonStringify(working.originalOverride?.value ?? null) ===
    stableJsonStringify(working.override)
  ) {
    return
  }
  if (working.override) {
    items.push({
      kind: "object-override-upsert",
      value: {
        ref: working.ref,
        value: working.override,
        expectedLastCommitId: working.originalOverride?.lastCommitId ?? null,
        lastCommitId: identity.commitId,
        updatedAt: identity.committedAt,
      },
    })
  } else if (working.originalOverride) {
    items.push({
      kind: "object-override-delete",
      value: { ref: working.ref, expectedLastCommitId: working.originalOverride.lastCommitId },
    })
  }
}

export function appendLinkEdgeOverrideWork(
  items: MaterializationPlanWorkItem[],
  working: WorkingLinkEdge,
  identity: TimedCommitIdentity
): void {
  if (
    stableJsonStringify(working.originalOverride?.value ?? null) ===
    stableJsonStringify(working.override)
  ) {
    return
  }
  if (working.override) {
    items.push({
      kind: "link-override-upsert",
      value: {
        ref: working.ref,
        value: working.override,
        expectedLastCommitId: working.originalOverride?.lastCommitId ?? null,
        lastCommitId: identity.commitId,
        updatedAt: identity.committedAt,
      },
    })
  } else if (working.originalOverride) {
    items.push({
      kind: "link-override-delete",
      value: { ref: working.ref, expectedLastCommitId: working.originalOverride.lastCommitId },
    })
  }
}

export function appendLinkSlotOverrideWork(
  items: MaterializationPlanWorkItem[],
  working: WorkingLinkSlot,
  identity: TimedCommitIdentity
): void {
  if (
    stableJsonStringify(working.originalOverride?.value ?? null) ===
    stableJsonStringify(working.override)
  ) {
    return
  }
  if (working.override) {
    items.push({
      kind: "link-slot-override-upsert",
      value: {
        ref: working.ref,
        value: working.override,
        expectedLastCommitId: working.originalOverride?.lastCommitId ?? null,
        lastCommitId: identity.commitId,
        updatedAt: identity.committedAt,
      },
    })
  } else if (working.originalOverride) {
    items.push({
      kind: "link-slot-override-delete",
      value: {
        ref: working.ref,
        expectedLastCommitId: working.originalOverride.lastCommitId,
      },
    })
  }
}

export function appendEffectiveObjectWork(
  items: MaterializationPlanWorkItem[],
  change: EffectiveObjectChange
): void {
  if (change.kind === "deleted") {
    items.push({
      kind: "object-delete",
      value: {
        ref: change.ref,
        expected: expectedObject(change.before),
      },
    })
  } else {
    items.push({
      kind: "object-upsert",
      value: {
        row: change.after,
        expected: change.before
          ? expectedObject(change.before)
          : { ref: change.ref, exists: false },
      },
    })
  }
}

export function appendEffectiveLinkWork(
  items: MaterializationPlanWorkItem[],
  change: EffectiveLinkChange
): void {
  if (change.kind === "deleted") {
    items.push({
      kind: "link-delete",
      value: {
        ref: change.ref,
        expected: expectedLink(change.before),
      },
    })
  } else {
    items.push({
      kind: "link-upsert",
      value: {
        row: change.after,
        expected: change.before ? expectedLink(change.before) : { ref: change.ref, exists: false },
      },
    })
  }
}

export function outboxItem(
  event: OntologyMaterializationEvent,
  committedAt: string
): MaterializationPlanItem {
  const value: OntologyOutboxWrite = {
    envelope: event,
    availableAt: committedAt,
    createdAt: committedAt,
  }
  return { kind: "outbox", value }
}

export function classificationWork(
  entityKind: MaterializationWorkEntityKind,
  identityKey: string,
  sortKey: string
): MaterializationClassificationWorkRecord {
  return {
    kind: "classification",
    recordKey: `classification:${entityKind}:${sortKey}`,
    entityKind,
    identityKey,
  }
}

export function planWork(
  item: MaterializationPlanWorkItem,
  sortKey: string
): MaterializationPlanWorkRecord {
  const applyPhase = materializationApplyPhase(item.kind)
  return {
    kind: "plan",
    recordKey: `plan:${item.kind}:${sortKey}`,
    applyPhase,
    sortKey,
    item,
  }
}

export function eventWork(value: OrderedMaterializationEventDraft): MaterializationEventWorkRecord {
  return {
    kind: "event",
    recordKey: `event:${value.kindRank}:${value.sortKey}`,
    eventKindRank: value.kindRank,
    sortKey: value.sortKey,
    draft: value.draft,
  }
}

function expectedObject(snapshot: NonNullable<EffectiveObjectChange["before"]>) {
  return {
    ref: snapshot.ref,
    exists: true as const,
    version: snapshot.version,
    lastCommitId: snapshot.lastCommitId,
  }
}

function expectedLink(snapshot: NonNullable<EffectiveLinkChange["before"]>) {
  return { ref: snapshot.ref, exists: true as const, lastCommitId: snapshot.lastCommitId }
}
