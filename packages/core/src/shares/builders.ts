import type { ObjectActionDefinition } from "../actions"
import type { ObjectTypeWithPropertyTokens } from "../ontology"
import {
  type LinkPathSelection,
  type LinkPathSelectionInput,
  type LinkPathSelectionMode,
  snapshotLinkPathSelection,
} from "../ontology/tokens"
import { ShareDefinitionError } from "./errors"
import type {
  DefineShareOptions,
  ShareActionGrant,
  ShareDefinition,
  ShareScopeGrant,
  ShareTarget,
  ShareViewGrant,
  ShareViewGrantBuilder,
} from "./types"

const shareTargets = new WeakSet<object>()

export function defineShare<
  const TId extends string,
  const TTarget extends ObjectTypeWithPropertyTokens,
  const TGrants extends readonly ShareScopeGrant[],
>(id: TId, options: DefineShareOptions<TTarget, TGrants>): ShareDefinition<TId, TTarget["id"]> {
  assertNonEmpty(id, "Share id")
  if (!isObjectType(options.target)) {
    throw invalid(`Share '${id}' target must be an object type.`)
  }
  if (typeof options.grants !== "function") {
    throw invalid(`Share '${id}' grants must be a function.`)
  }
  if (options.description !== undefined && typeof options.description !== "string") {
    throw invalid(`Share '${id}' description must be a string.`)
  }

  const target = createShareTarget(options.target.id)
  let authoredGrants: readonly unknown[]
  try {
    authoredGrants = options.grants({ target })
  } catch (error) {
    if (error instanceof ShareDefinitionError) throw error
    const reason = error instanceof Error ? error.message.replace(/^\[Sixb\] /, "") : String(error)
    throw invalid(`Share '${id}' grants are invalid: ${reason}`)
  }
  if (!Array.isArray(authoredGrants) || authoredGrants.length === 0) {
    throw invalid(`Share '${id}' must declare at least one grant.`)
  }
  const grants = snapshotShareGrants(id, options.target.id, authoredGrants)

  return Object.freeze({
    kind: "share" as const,
    id,
    target: Object.freeze({ kind: "object" as const, objectTypeId: options.target.id }),
    grants,
    ...(options.description === undefined ? {} : { description: options.description }),
  })
}

export function isShareDefinition(value: unknown): value is ShareDefinition {
  if (!isRecord(value) || value.kind !== "share" || !isNonEmpty(value.id)) return false
  if (
    !isRecord(value.target) ||
    value.target.kind !== "object" ||
    !isNonEmpty(value.target.objectTypeId)
  ) {
    return false
  }
  return Array.isArray(value.grants)
}

/** @internal Validate, canonicalize, and detach a definition before runtime registration/use. */
export function snapshotShareDefinition(value: unknown): ShareDefinition {
  try {
    if (!isRecord(value)) {
      throw invalid("Share definition kind must be 'share'.")
    }
    const kind = value.kind
    const authoredId = value.id
    const target = value.target
    const authoredGrants = value.grants
    const description = value.description
    if (kind !== "share") {
      throw invalid("Share definition kind must be 'share'.")
    }
    const id = nonEmpty(authoredId, "Share id")
    if (!isRecord(target)) {
      throw invalid(`Share '${id}' target must be an object type.`)
    }
    const targetKind = target.kind
    const authoredObjectTypeId = target.objectTypeId
    if (targetKind !== "object" || !isNonEmpty(authoredObjectTypeId)) {
      throw invalid(`Share '${id}' target must be an object type.`)
    }
    if (!Array.isArray(authoredGrants) || authoredGrants.length === 0) {
      throw invalid(`Share '${id}' must declare grants.`)
    }
    if (description !== undefined && typeof description !== "string") {
      throw invalid(`Share '${id}' description must be a string.`)
    }

    const objectTypeId = authoredObjectTypeId
    return Object.freeze({
      kind: "share" as const,
      id,
      target: Object.freeze({ kind: "object" as const, objectTypeId }),
      grants: snapshotShareGrants(id, objectTypeId, authoredGrants),
      ...(description === undefined ? {} : { description }),
    })
  } catch (error) {
    if (error instanceof ShareDefinitionError) throw error
    const reason = error instanceof Error ? error.message.replace(/^\[Sixb\] /, "") : String(error)
    throw invalid(`Share definition is invalid: ${reason}`)
  }
}

/** @internal Contextual overload used by `can.view(target)`. */
export function isShareTarget(value: unknown): value is ShareTarget {
  return typeof value === "object" && value !== null && shareTargets.has(value)
}

/** @internal Contextual overload used by `can.view(target)`. */
export function createShareViewGrant<TObjectTypeId extends string>(
  target: ShareTarget<TObjectTypeId>
): ShareViewGrantBuilder<TObjectTypeId> {
  assertShareTarget(target)
  return createShareViewGrantWithLinks(target.objectTypeId, Object.freeze({ kind: "none" }))
}

/** @internal Contextual overload used by `can.apply(action).on(target)`. */
export function createShareActionGrant<TAction extends ObjectActionDefinition>(
  action: TAction,
  target: ShareTarget<TAction["binding"]["objectType"]["id"]>
): ShareActionGrant<TAction["id"], TAction["binding"]["objectType"]["id"]> {
  assertShareTarget(target)
  const objectTypeId = action.binding.objectType.id
  if (target.objectTypeId !== objectTypeId) {
    throw invalid(
      `Action '${action.id}' is defined on '${objectTypeId}', not Share target '${target.objectTypeId}'. Shared Actions are exact-type only in V1.`
    )
  }
  return Object.freeze({
    kind: "action.apply" as const,
    actionId: action.id,
    subjectObjectTypeId: target.objectTypeId,
  })
}

function createShareTarget<TObjectTypeId extends string>(
  objectTypeId: TObjectTypeId
): ShareTarget<TObjectTypeId> {
  const target = { objectTypeId } as ShareTarget<TObjectTypeId>
  shareTargets.add(target)
  return Object.freeze(target)
}

function createShareViewGrantWithLinks<TObjectTypeId extends string>(
  targetObjectTypeId: TObjectTypeId,
  links: LinkPathSelectionMode
): ShareViewGrantBuilder<TObjectTypeId> {
  const grant = {
    kind: "object.view" as const,
    targetObjectTypeId,
    links,
  } as ShareViewGrantBuilder<TObjectTypeId>
  Object.defineProperty(grant, "withLinks", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: (...args: [links?: readonly LinkPathSelectionInput<TObjectTypeId>[]]) => {
      if (args.length === 0) {
        return freezeViewGrant(targetObjectTypeId, Object.freeze({ kind: "all" }))
      }
      const selected = args[0]
      if (!Array.isArray(selected)) {
        throw invalid("withLinks(...) expects an array, or no argument for every direct link.")
      }
      return freezeViewGrant(
        targetObjectTypeId,
        Object.freeze({
          kind: "selected" as const,
          links: Object.freeze(selected.map(snapshotLinkPathSelection)),
        })
      )
    },
  })
  return Object.freeze(grant)
}

function freezeViewGrant<TObjectTypeId extends string>(
  targetObjectTypeId: TObjectTypeId,
  links: LinkPathSelectionMode
): ShareViewGrant<TObjectTypeId> {
  return Object.freeze({ kind: "object.view" as const, targetObjectTypeId, links })
}

function snapshotShareGrants(
  shareId: string,
  targetObjectTypeId: string,
  authored: readonly unknown[]
): readonly ShareScopeGrant[] {
  const grants: ShareScopeGrant[] = []
  const actionIds = new Set<string>()
  let viewCount = 0

  for (let index = 0; index < authored.length; index += 1) {
    const grant = authored[index]
    if (!isRecord(grant)) {
      throw invalid(`Share '${shareId}' grant ${index} must come from 'can'.`)
    }
    const kind = grant.kind
    if (kind === "object.view") {
      const authoredTargetObjectTypeId = grant.targetObjectTypeId
      const links = grant.links
      if (authoredTargetObjectTypeId !== targetObjectTypeId) {
        throw invalid(`Share '${shareId}' view grant must use its contextual target.`)
      }
      viewCount += 1
      if (viewCount > 1) {
        throw invalid(`Share '${shareId}' must declare exactly one view grant.`)
      }
      grants.push(
        Object.freeze({
          kind: "object.view" as const,
          targetObjectTypeId,
          links: snapshotLinkMode(links),
        })
      )
      continue
    }
    if (kind === "action.apply") {
      const actionId = grant.actionId
      const subjectObjectTypeId = grant.subjectObjectTypeId
      if (!isNonEmpty(actionId) || subjectObjectTypeId !== targetObjectTypeId) {
        throw invalid(`Share '${shareId}' action grant must apply to its contextual target.`)
      }
      if (actionIds.has(actionId)) {
        throw invalid(`Share '${shareId}' contains duplicate action '${actionId}'.`)
      }
      actionIds.add(actionId)
      grants.push(
        Object.freeze({
          kind: "action.apply" as const,
          actionId,
          subjectObjectTypeId: targetObjectTypeId,
        })
      )
      continue
    }
    throw invalid(`Share '${shareId}' grant ${index} must come from 'can'.`)
  }

  if (viewCount !== 1) {
    throw invalid(`Share '${shareId}' must declare exactly one can.view(target) grant.`)
  }
  return Object.freeze(grants)
}

function snapshotLinkMode(value: unknown): LinkPathSelectionMode {
  if (!isRecord(value)) throw invalid("Share link selection must be an object.")
  const kind = value.kind
  const links = value.links
  if (kind === "none" || kind === "all") {
    return Object.freeze({ kind })
  }
  if (kind !== "selected" || !Array.isArray(links)) {
    throw invalid("Share link selection must be none, all, or selected links.")
  }
  if (links.length === 0) {
    throw invalid("withLinks([]) is empty; omit withLinks() when no links should be shared.")
  }
  try {
    return Object.freeze({
      kind: "selected" as const,
      links: snapshotLinkPaths(links),
    })
  } catch (error) {
    if (error instanceof ShareDefinitionError) throw error
    const reason = error instanceof Error ? error.message.replace(/^\[Sixb\] /, "") : String(error)
    throw invalid(`Share link selection is invalid: ${reason}`)
  }
}

function snapshotLinkPaths(values: readonly unknown[]): readonly LinkPathSelection[] {
  const byKey = new Map<string, LinkPathSelection>()
  for (const value of values) {
    const captured = canonicalizeLinkPath(
      snapshotLinkPathSelection(value as LinkPathSelectionInput)
    )
    const key = JSON.stringify([captured.sourceObjectTypeId, captured.linkId])
    const current = byKey.get(key)
    if (!current) {
      byKey.set(key, captured)
      continue
    }
    if (!sameLinkTargets(current.targetObjectTypeId, captured.targetObjectTypeId)) {
      throw invalid(
        `Link '${captured.sourceObjectTypeId}.${captured.linkId}' declares inconsistent targets.`
      )
    }
    byKey.set(
      key,
      Object.freeze({
        ...current,
        selection: mergeLinkModes(current.selection, captured.selection),
      })
    )
  }
  return Object.freeze([...byKey.values()])
}

function canonicalizeLinkPath(value: LinkPathSelection): LinkPathSelection {
  return Object.freeze({
    ...value,
    selection:
      value.selection.kind === "selected"
        ? Object.freeze({
            kind: "selected" as const,
            links: snapshotLinkPaths(value.selection.links),
          })
        : value.selection,
  })
}

function mergeLinkModes(
  left: LinkPathSelectionMode,
  right: LinkPathSelectionMode
): LinkPathSelectionMode {
  if (left.kind === "all" || right.kind === "all") return Object.freeze({ kind: "all" })
  if (left.kind === "none") return right
  if (right.kind === "none") return left
  return Object.freeze({
    kind: "selected" as const,
    links: snapshotLinkPaths([...left.links, ...right.links]),
  })
}

function sameLinkTargets(
  left: string | readonly string[],
  right: string | readonly string[]
): boolean {
  if (typeof left === "string" || typeof right === "string") return left === right
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function assertShareTarget(value: unknown): asserts value is ShareTarget {
  if (!isShareTarget(value)) {
    throw invalid("Shared grants must use the target provided by defineShare(...).")
  }
}

function isObjectType(value: unknown): value is ObjectTypeWithPropertyTokens {
  return (
    isRecord(value) &&
    isNonEmpty(value.id) &&
    Array.isArray(value.properties) &&
    Array.isArray(value.links)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function assertNonEmpty(value: unknown, field: string): asserts value is string {
  if (!isNonEmpty(value)) throw invalid(`${field} must not be empty.`)
}

function nonEmpty(value: unknown, field: string): string {
  assertNonEmpty(value, field)
  return value
}

function invalid(message: string): ShareDefinitionError {
  return new ShareDefinitionError(`[Sixb] ${message}`)
}
