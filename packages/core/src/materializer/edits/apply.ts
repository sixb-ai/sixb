import type { JsonValue } from "../../json"
import { stableJsonStringify } from "../../json"
import { MaterializationValidationError } from "../../materialization/errors"
import type {
  LinkOverride,
  ObjectOverride,
  OntologyEditOperation,
} from "../../materialization/model"

type ObjectEditOperation = Extract<
  OntologyEditOperation,
  { readonly ref: { readonly objectTypeId: string } }
>
type LinkEditOperation = Extract<
  OntologyEditOperation,
  { readonly ref: { readonly linkId: string } }
>
type ObjectWriteOperation = Extract<
  ObjectEditOperation,
  { readonly kind: "object.create" | "object.upsert" }
>
type ObjectPatchOverride = Extract<ObjectOverride, { readonly kind: "patch" }>

interface ObjectEditInput {
  readonly operation: ObjectEditOperation
  readonly sourceProperties: Readonly<Record<string, JsonValue>> | null
  readonly authority: ObjectOverride | null
  readonly editedAt: Readonly<Record<string, string>>
  readonly committedAt: string
  readonly effectiveExists: boolean
  readonly normalizedProperties?: Readonly<Record<string, JsonValue>>
  readonly normalizedSet?: Readonly<Record<string, JsonValue>>
}

interface LinkEditInput {
  readonly operation: LinkEditOperation
  readonly hasSource: boolean
  readonly authority: LinkOverride | null
  readonly effectiveExists: boolean
  readonly normalizedProperties?: Readonly<Record<string, JsonValue>>
}

export interface AuthorityTransition<T> {
  readonly next: T | null
  readonly changed: boolean
}

export interface ObjectAuthorityTransition extends AuthorityTransition<ObjectOverride> {
  readonly editedAt: Readonly<Record<string, string>>
}

export function applyObjectEdit(input: ObjectEditInput): ObjectAuthorityTransition {
  const current = input.authority
  let next: ObjectOverride | null

  switch (input.operation.kind) {
    case "object.create":
      next = applyObjectCreate(input, input.operation)
      break
    case "object.upsert":
      next = applyObjectUpsert(input, input.operation)
      break
    case "object.patch":
      next = applyObjectPatch(input, input.operation)
      break
    case "object.delete":
      next = applyObjectDelete(input)
      break
    case "object.restore":
      next = applyObjectRestore(input)
      break
    default:
      throw new MaterializationValidationError("Expected an object edit operation.")
  }

  const editedAt = applyObjectEditTimes(input, next)
  const authority = transition(current, next)
  return {
    ...authority,
    editedAt,
    changed: authority.changed || !sameStringRecord(input.editedAt, editedAt),
  }
}

function applyObjectEditTimes(
  input: ObjectEditInput,
  next: ObjectOverride | null
): Readonly<Record<string, string>> {
  if (!next || next.kind === "delete") return {}
  const editedAt =
    input.operation.kind === "object.create" || input.authority?.kind === "delete"
      ? {}
      : { ...input.editedAt }

  switch (input.operation.kind) {
    case "object.create":
    case "object.upsert": {
      const properties = input.normalizedProperties ?? input.operation.properties
      for (const propertyId of Object.keys(properties)) editedAt[propertyId] = input.committedAt
      break
    }
    case "object.patch":
      for (const propertyId of input.operation.reset) delete editedAt[propertyId]
      for (const propertyId of input.operation.unset) editedAt[propertyId] = input.committedAt
      for (const propertyId of Object.keys(input.normalizedSet ?? input.operation.set)) {
        editedAt[propertyId] = input.committedAt
      }
      break
    case "object.delete":
      return editedAt
    case "object.restore":
      break
  }
  return editedAt
}

function sameStringRecord(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>
): boolean {
  const leftKeys = Object.keys(left)
  if (leftKeys.length !== Object.keys(right).length) return false
  return leftKeys.every((key) => left[key] === right[key])
}

function applyObjectCreate(
  input: ObjectEditInput,
  operation: ObjectWriteOperation
): ObjectOverride {
  if (input.sourceProperties || input.authority) {
    throw new MaterializationValidationError(
      `Object create requires complete authority absence for ${operation.ref.objectTypeId}:${operation.ref.primaryId}.`
    )
  }
  return { kind: "create", properties: input.normalizedProperties ?? operation.properties }
}

function applyObjectUpsert(
  input: ObjectEditInput,
  operation: ObjectWriteOperation
): ObjectOverride {
  const properties = input.normalizedProperties ?? operation.properties
  const current = input.authority

  if (current?.kind === "create") {
    return { kind: "create", properties: { ...current.properties, ...properties } }
  }
  if (current?.kind === "patch") {
    return mergeUpsertIntoPatch(current, properties, input.sourceProperties !== null)
  }
  if (input.sourceProperties) return { kind: "patch", set: properties, unset: [] }
  return { kind: "create", properties }
}

function mergeUpsertIntoPatch(
  current: ObjectPatchOverride,
  properties: Readonly<Record<string, JsonValue>>,
  hasSource: boolean
): ObjectOverride {
  if (hasSource) {
    const unset = current.unset.filter((propertyId) => !(propertyId in properties))
    return { kind: "patch", set: { ...current.set, ...properties }, unset }
  }

  const created = { ...current.set }
  for (const propertyId of current.unset) delete created[propertyId]
  return { kind: "create", properties: { ...created, ...properties } }
}

function applyObjectPatch(
  input: ObjectEditInput,
  operation: Extract<ObjectEditOperation, { readonly kind: "object.patch" }>
): ObjectOverride | null {
  const current = input.authority
  if (!input.effectiveExists && current?.kind !== "patch") {
    throw new MaterializationValidationError(
      `Object patch requires an effective object for ${operation.ref.objectTypeId}:${operation.ref.primaryId}.`
    )
  }

  const setInput = input.normalizedSet ?? operation.set
  if (current?.kind === "create" && !input.sourceProperties) {
    return patchCreatedObject(current, operation, setInput)
  }

  return patchOverride(toPatchOverride(current), operation, setInput)
}

function patchCreatedObject(
  current: Extract<ObjectOverride, { readonly kind: "create" }>,
  operation: Extract<ObjectEditOperation, { readonly kind: "object.patch" }>,
  setInput: Readonly<Record<string, JsonValue>>
): ObjectOverride {
  const properties = { ...current.properties, ...setInput }
  for (const propertyId of [...operation.unset, ...operation.reset]) {
    delete properties[propertyId]
  }
  return { kind: "create", properties }
}

function toPatchOverride(current: ObjectOverride | null): ObjectPatchOverride {
  if (current?.kind === "patch") return current
  if (current?.kind === "create") {
    return { kind: "patch", set: { ...current.properties }, unset: [] }
  }
  return { kind: "patch", set: {}, unset: [] }
}

function patchOverride(
  base: ObjectPatchOverride,
  operation: Extract<ObjectEditOperation, { readonly kind: "object.patch" }>,
  setInput: Readonly<Record<string, JsonValue>>
): ObjectOverride | null {
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

  if (Object.keys(set).length === 0 && unset.size === 0) return null
  return { kind: "patch", set, unset: [...unset].sort() }
}

function applyObjectDelete(input: ObjectEditInput): ObjectOverride | null {
  if (!input.effectiveExists) return input.authority
  if (input.authority?.kind === "create" && !input.sourceProperties) return null
  return { kind: "delete" }
}

function applyObjectRestore(input: ObjectEditInput): ObjectOverride | null {
  if (input.authority?.kind !== "delete") return input.authority
  return null
}

export function applyLinkEdit(input: LinkEditInput): AuthorityTransition<LinkOverride> {
  const current = input.authority
  let next: LinkOverride | null

  switch (input.operation.kind) {
    case "link.upsert":
      next = linkUpsertOverride(input)
      break
    case "link.delete":
      next = linkDeleteOverride(input)
      break
    case "link.reset":
      next = null
      break
    default:
      throw new MaterializationValidationError("Expected a link edit operation.")
  }

  return transition(current, next)
}

function linkUpsertOverride(input: LinkEditInput): LinkOverride {
  if (input.normalizedProperties !== undefined) {
    return { kind: "upsert", properties: input.normalizedProperties }
  }
  if (input.operation.kind === "link.upsert" && input.operation.properties !== undefined) {
    return { kind: "upsert", properties: input.operation.properties }
  }
  return { kind: "upsert" }
}

function linkDeleteOverride(input: LinkEditInput): LinkOverride | null {
  if (!input.effectiveExists) return input.authority
  if (input.authority?.kind === "upsert" && !input.hasSource) return null
  return { kind: "delete" }
}

function transition<T extends ObjectOverride | LinkOverride>(
  current: T | null,
  next: T | null
): AuthorityTransition<T> {
  return { next, changed: !sameAuthority(current, next) }
}

function sameAuthority(
  left: ObjectOverride | LinkOverride | null,
  right: ObjectOverride | LinkOverride | null
): boolean {
  return stableJsonStringify(left) === stableJsonStringify(right)
}
