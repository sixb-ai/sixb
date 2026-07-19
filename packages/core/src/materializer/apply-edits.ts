import { stableJsonStringify } from "../json"
import { MaterializationValidationError } from "./errors"
import type {
  EffectiveLinkSnapshot,
  EffectiveObjectSnapshot,
  LinkOverride,
  ObjectOverride,
  OntologyEditOperation,
} from "./types"

export interface AuthorityTransition<T> {
  readonly next: T | null
  readonly changed: boolean
}

export function applyObjectEdit(input: {
  readonly operation: Extract<
    OntologyEditOperation,
    { readonly ref: { readonly objectTypeId: string } }
  >
  readonly sourceProperties: Readonly<Record<string, import("../json").JsonValue>> | null
  readonly authority: ObjectOverride | null
  readonly effective: EffectiveObjectSnapshot | null
  readonly normalizedProperties?: Readonly<Record<string, import("../json").JsonValue>>
  readonly normalizedSet?: Readonly<Record<string, import("../json").JsonValue>>
}): AuthorityTransition<ObjectOverride> {
  const operation = input.operation
  const current = input.authority
  let next: ObjectOverride | null = current

  if (operation.kind === "object.create") {
    if (input.sourceProperties || current) {
      throw new MaterializationValidationError(
        `Object create requires complete authority absence for ${operation.ref.objectTypeId}:${operation.ref.primaryId}.`
      )
    }
    next = { kind: "create", properties: input.normalizedProperties ?? operation.properties }
  } else if (operation.kind === "object.upsert") {
    const properties = input.normalizedProperties ?? operation.properties
    if (current?.kind === "create") {
      next = { kind: "create", properties: { ...current.properties, ...properties } }
    } else if (current?.kind === "patch") {
      if (input.sourceProperties) {
        const unset = current.unset.filter((propertyId) => !(propertyId in properties))
        next = { kind: "patch", set: { ...current.set, ...properties }, unset }
      } else {
        const created = { ...current.set }
        for (const propertyId of current.unset) delete created[propertyId]
        next = { kind: "create", properties: { ...created, ...properties } }
      }
    } else if (input.sourceProperties) {
      next = { kind: "patch", set: properties, unset: [] }
    } else {
      next = { kind: "create", properties }
    }
  } else if (operation.kind === "object.patch") {
    if (!input.effective && current?.kind !== "patch") {
      throw new MaterializationValidationError(
        `Object patch requires an effective object for ${operation.ref.objectTypeId}:${operation.ref.primaryId}.`
      )
    }
    const setInput = input.normalizedSet ?? operation.set
    if (current?.kind === "create" && !input.sourceProperties) {
      const properties = { ...current.properties, ...setInput }
      for (const propertyId of [...operation.unset, ...operation.reset])
        delete properties[propertyId]
      next = { kind: "create", properties }
    } else {
      const base =
        current?.kind === "patch"
          ? current
          : current?.kind === "create"
            ? {
                kind: "patch" as const,
                set: { ...current.properties },
                unset: [] as readonly string[],
              }
            : { kind: "patch" as const, set: {}, unset: [] as readonly string[] }
      const set = { ...base.set }
      const unset = new Set(base.unset)
      for (const propertyId of operation.reset) {
        delete set[propertyId]
        unset.delete(propertyId)
      }
      for (const propertyId of operation.unset) {
        delete set[propertyId]
        unset.add(propertyId)
      }
      for (const [propertyId, value] of Object.entries(setInput)) {
        set[propertyId] = value
        unset.delete(propertyId)
      }
      next =
        Object.keys(set).length === 0 && unset.size === 0
          ? null
          : { kind: "patch", set, unset: [...unset].sort() }
    }
  } else if (operation.kind === "object.delete") {
    if (!input.effective) return { next: current, changed: false }
    if (current?.kind === "create" && !input.sourceProperties) next = null
    else next = { kind: "delete" }
  } else if (operation.kind === "object.restore") {
    if (current?.kind !== "delete") return { next: current, changed: false }
    next = null
  } else {
    throw new MaterializationValidationError("Expected an object edit operation.")
  }

  return { next, changed: !sameAuthority(current, next) }
}

export function applyLinkEdit(input: {
  readonly operation: Extract<OntologyEditOperation, { readonly ref: { readonly linkId: string } }>
  readonly hasSource: boolean
  readonly authority: LinkOverride | null
  readonly effective: EffectiveLinkSnapshot | null
  readonly normalizedProperties?: Readonly<Record<string, import("../json").JsonValue>>
}): AuthorityTransition<LinkOverride> {
  const current = input.authority
  let next: LinkOverride | null = current
  if (input.operation.kind === "link.upsert") {
    next = {
      kind: "upsert",
      ...(input.normalizedProperties !== undefined
        ? { properties: input.normalizedProperties }
        : input.operation.properties !== undefined
          ? { properties: input.operation.properties }
          : {}),
    }
  } else if (input.operation.kind === "link.delete") {
    if (!input.effective) return { next: current, changed: false }
    next = current?.kind === "upsert" && !input.hasSource ? null : { kind: "delete" }
  } else if (input.operation.kind === "link.reset") {
    next = null
  } else {
    throw new MaterializationValidationError("Expected a link edit operation.")
  }
  return { next, changed: !sameAuthority(current, next) }
}

function sameAuthority(
  left: ObjectOverride | LinkOverride | null,
  right: ObjectOverride | LinkOverride | null
): boolean {
  return stableJsonStringify(left) === stableJsonStringify(right)
}
