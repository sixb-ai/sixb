import { compareStrings, type JsonValue, stableJsonStringify } from "../json"
import type { ResolvedLinkValue, ResolvedObjectValue } from "./resolve-effective"
import type {
  EffectiveLinkChange,
  EffectiveLinkSnapshot,
  EffectiveObjectChange,
  EffectiveObjectSnapshot,
  OntologyMaterializationPropertyChangeMap,
} from "./types"

export function diffEffectiveObject(input: {
  readonly before: EffectiveObjectSnapshot | null
  readonly resolved: ResolvedObjectValue | null
  readonly commitId: string
  readonly committedAt: string
}): EffectiveObjectChange | null {
  if (!input.before && !input.resolved) return null
  if (!input.before && input.resolved) {
    const after: EffectiveObjectSnapshot = {
      ...input.resolved,
      version: 1,
      createdAt: input.committedAt,
      updatedAt: input.committedAt,
      lastCommitId: input.commitId,
    }
    return {
      kind: "created",
      ref: after.ref,
      before: null,
      after,
      propertyChanges: propertyChanges({}, after.properties),
    }
  }
  if (input.before && !input.resolved) {
    return {
      kind: "deleted",
      ref: input.before.ref,
      before: input.before,
      after: null,
      propertyChanges: propertyChanges(input.before.properties, {}),
    }
  }
  if (!input.before || !input.resolved) return null
  if (
    stableJsonStringify(input.before.properties) === stableJsonStringify(input.resolved.properties)
  )
    return null
  const after: EffectiveObjectSnapshot = {
    ...input.resolved,
    version: input.before.version + 1,
    createdAt: input.before.createdAt,
    updatedAt: input.committedAt,
    lastCommitId: input.commitId,
  }
  return {
    kind: "updated",
    ref: after.ref,
    before: input.before,
    after,
    propertyChanges: propertyChanges(input.before.properties, after.properties),
  }
}

export function diffEffectiveLink(input: {
  readonly before: EffectiveLinkSnapshot | null
  readonly resolved: ResolvedLinkValue | null
  readonly commitId: string
  readonly committedAt: string
}): EffectiveLinkChange | null {
  if (!input.before && !input.resolved) return null
  if (!input.before && input.resolved) {
    const after: EffectiveLinkSnapshot = {
      ...input.resolved,
      createdAt: input.committedAt,
      updatedAt: input.committedAt,
      lastCommitId: input.commitId,
    }
    return {
      kind: "created",
      ref: after.ref,
      before: null,
      after,
      propertyChanges: propertyChanges({}, after.properties ?? {}),
    }
  }
  if (input.before && !input.resolved) {
    return {
      kind: "deleted",
      ref: input.before.ref,
      before: input.before,
      after: null,
      propertyChanges: propertyChanges(input.before.properties ?? {}, {}),
    }
  }
  if (!input.before || !input.resolved) return null
  if (
    stableJsonStringify(input.before.properties ?? {}) ===
    stableJsonStringify(input.resolved.properties ?? {})
  )
    return null
  const after: EffectiveLinkSnapshot = {
    ...input.resolved,
    createdAt: input.before.createdAt,
    updatedAt: input.committedAt,
    lastCommitId: input.commitId,
  }
  return {
    kind: "updated",
    ref: after.ref,
    before: input.before,
    after,
    propertyChanges: propertyChanges(input.before.properties ?? {}, after.properties ?? {}),
  }
}

function propertyChanges(
  before: Readonly<Record<string, JsonValue>>,
  after: Readonly<Record<string, JsonValue>>
): OntologyMaterializationPropertyChangeMap {
  const changes: Record<string, import("./types").OntologyMaterializationPropertyChange> = {}
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
