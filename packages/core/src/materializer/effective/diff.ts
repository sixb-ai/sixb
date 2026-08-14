import { compareStrings, type JsonValue, stableJsonStringify } from "../../json"
import type {
  EffectiveLinkChange,
  EffectiveLinkSnapshot,
  EffectiveObjectChange,
  EffectiveObjectSnapshot,
  OntologyMaterializationPropertyChangeMap,
} from "../../materialization/model"
import { linkRefKey } from "../../materialization/refs"
import type { ResolvedLinkValue, ResolvedObjectValue } from "./resolve"

export function diffEffectiveObject(input: {
  readonly before: EffectiveObjectSnapshot | null
  readonly resolved: ResolvedObjectValue | null
  readonly commitId: string
  readonly committedAt: string
}): EffectiveObjectChange | null {
  if (!input.before) {
    if (!input.resolved) return null
    return createObjectChange(input.resolved, input.commitId, input.committedAt)
  }
  if (!input.resolved) return deleteObjectChange(input.before)
  if (sameProperties(input.before.properties, input.resolved.properties)) return null
  return updateObjectChange(input.before, input.resolved, input.commitId, input.committedAt)
}

function createObjectChange(
  resolved: ResolvedObjectValue,
  commitId: string,
  committedAt: string
): EffectiveObjectChange {
  const after: EffectiveObjectSnapshot = {
    ...resolved,
    version: 1,
    createdAt: committedAt,
    updatedAt: committedAt,
    lastCommitId: commitId,
  }
  return {
    kind: "created",
    ref: after.ref,
    before: null,
    after,
    propertyChanges: propertyChanges({}, after.properties),
  }
}

function deleteObjectChange(before: EffectiveObjectSnapshot): EffectiveObjectChange {
  return {
    kind: "deleted",
    ref: before.ref,
    before,
    after: null,
    propertyChanges: propertyChanges(before.properties, {}),
  }
}

function updateObjectChange(
  before: EffectiveObjectSnapshot,
  resolved: ResolvedObjectValue,
  commitId: string,
  committedAt: string
): EffectiveObjectChange {
  const after: EffectiveObjectSnapshot = {
    ...resolved,
    version: before.version + 1,
    createdAt: before.createdAt,
    updatedAt: committedAt,
    lastCommitId: commitId,
  }
  return {
    kind: "updated",
    ref: after.ref,
    before,
    after,
    propertyChanges: propertyChanges(before.properties, after.properties),
  }
}

export function diffEffectiveLink(input: {
  readonly before: EffectiveLinkSnapshot | null
  readonly resolved: ResolvedLinkValue | null
  readonly commitId: string
  readonly committedAt: string
}): EffectiveLinkChange | null {
  if (!input.before) {
    if (!input.resolved) return null
    return createLinkChange(input.resolved, input.commitId, input.committedAt)
  }
  if (!input.resolved) return deleteLinkChange(input.before)
  if (sameProperties(input.before.properties ?? {}, input.resolved.properties ?? {})) return null
  return updateLinkChange(input.before, input.resolved, input.commitId, input.committedAt)
}

/** Diffs a cardinality-one value slot while preserving edge identity at the physical boundary. */
export function diffEffectiveLinkSlot(input: {
  readonly before: EffectiveLinkSnapshot | null
  readonly resolved: ResolvedLinkValue | null
  readonly commitId: string
  readonly committedAt: string
}): EffectiveLinkChange[] {
  if (
    input.before &&
    input.resolved &&
    linkRefKey(input.before.ref) !== linkRefKey(input.resolved.ref)
  ) {
    return [
      diffEffectiveLink({ ...input, resolved: null })!,
      diffEffectiveLink({ ...input, before: null })!,
    ]
  }
  const change = diffEffectiveLink(input)
  return change ? [change] : []
}

function createLinkChange(
  resolved: ResolvedLinkValue,
  commitId: string,
  committedAt: string
): EffectiveLinkChange {
  const after: EffectiveLinkSnapshot = {
    ...resolved,
    createdAt: committedAt,
    updatedAt: committedAt,
    lastCommitId: commitId,
  }
  return {
    kind: "created",
    ref: after.ref,
    before: null,
    after,
    propertyChanges: propertyChanges({}, after.properties ?? {}),
  }
}

function deleteLinkChange(before: EffectiveLinkSnapshot): EffectiveLinkChange {
  return {
    kind: "deleted",
    ref: before.ref,
    before,
    after: null,
    propertyChanges: propertyChanges(before.properties ?? {}, {}),
  }
}

function updateLinkChange(
  before: EffectiveLinkSnapshot,
  resolved: ResolvedLinkValue,
  commitId: string,
  committedAt: string
): EffectiveLinkChange {
  const after: EffectiveLinkSnapshot = {
    ...resolved,
    createdAt: before.createdAt,
    updatedAt: committedAt,
    lastCommitId: commitId,
  }
  return {
    kind: "updated",
    ref: after.ref,
    before,
    after,
    propertyChanges: propertyChanges(before.properties ?? {}, after.properties ?? {}),
  }
}

function sameProperties(
  left: Readonly<Record<string, JsonValue>>,
  right: Readonly<Record<string, JsonValue>>
): boolean {
  return stableJsonStringify(left) === stableJsonStringify(right)
}

function propertyChanges(
  before: Readonly<Record<string, JsonValue>>,
  after: Readonly<Record<string, JsonValue>>
): OntologyMaterializationPropertyChangeMap {
  const changes: Record<
    string,
    import("../../materialization/model").OntologyMaterializationPropertyChange
  > = {}
  const ids = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort(compareStrings)
  for (const id of ids) {
    if (!(id in before)) changes[id] = { operation: "created", after: after[id] }
    else if (!(id in after)) changes[id] = { operation: "cleared", before: before[id], after: null }
    else if (stableJsonStringify(before[id]) !== stableJsonStringify(after[id])) {
      changes[id] = { operation: "updated", before: before[id], after: after[id] }
    }
  }
  return changes
}
