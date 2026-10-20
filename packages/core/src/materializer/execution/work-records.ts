import { stableJsonStringify } from "../../json"
import type { EffectiveLinkChange, EffectiveObjectChange } from "../../materialization/model"
import { canonicalIdentitySortKey } from "../../materialization/refs"
import type { OntologyRegistry } from "../../ontology"
import { UNIQUE_VALUE_KEY_VERSION, uniqueValueKey } from "../../ontology/unique-values"
import type {
  ExactUniqueValueWrite,
  MaterializationClassificationWorkRecord,
  MaterializationEventWorkRecord,
  MaterializationPlanWorkItem,
  MaterializationPlanWorkRecord,
  MaterializationWorkEntityKind,
  MaterializationWorkRecord,
} from "../../storage/ontology"
import { materializationApplyPhase } from "../../storage/ontology/materializations"
import type { WorkingLinkEdge, WorkingLinkSlot, WorkingObject } from "../edits/working-state"
import type { OrderedMaterializationEventDraft } from "../effective/build-events"
import type { TimedCommitIdentity } from "../shared/identity"

export function appendObjectOverrideWork(
  items: MaterializationPlanWorkItem[],
  working: WorkingObject,
  identity: TimedCommitIdentity
): void {
  if (
    stableJsonStringify(working.originalOverride?.value ?? null) ===
      stableJsonStringify(working.override) &&
    stableJsonStringify(working.originalEditedAt) === stableJsonStringify(working.editedAt)
  ) {
    return
  }
  if (working.override) {
    items.push({
      kind: "object-override-upsert",
      value: {
        ref: working.ref,
        value: working.override,
        editedAt: working.editedAt,
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

/**
 * Releases the unique values an object change gives up and claims those it takes. Storage applies
 * every release of a commit before its first claim, so values can move between its objects.
 */
export function appendUniqueValueWork(
  work: MaterializationWorkRecord[],
  change: EffectiveObjectChange,
  ontology: OntologyRegistry
): void {
  const properties = ontology.listUniqueProperties(change.ref.objectTypeId)
  if (properties.length === 0) return

  const before = change.before?.properties
  const after = change.kind === "deleted" ? undefined : change.after.properties

  for (const { propertyId, kind } of properties) {
    const released = uniqueValueKey(kind, before?.[propertyId])
    const claimed = uniqueValueKey(kind, after?.[propertyId])
    if (released === claimed) continue

    const sortKey = canonicalIdentitySortKey([
      change.ref.objectTypeId,
      change.ref.primaryId,
      propertyId,
    ])
    const value = (valueKey: string): ExactUniqueValueWrite => ({
      objectTypeId: change.ref.objectTypeId,
      propertyId,
      valueKey,
      primaryId: change.ref.primaryId,
    })

    if (released !== null) {
      work.push(planWork({ kind: "unique-value-release", value: value(released) }, sortKey))
    }
    if (claimed !== null) {
      const claim = { ...value(claimed), keyKind: kind, keyVersion: UNIQUE_VALUE_KEY_VERSION }
      work.push(planWork({ kind: "unique-value-claim", value: claim }, sortKey))
    }
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
