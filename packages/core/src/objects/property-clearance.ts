import { AuthorizationError } from "../authorization/errors"
import type { OntologyDefinitionCatalog } from "../ontology/registry"
import {
  type AppliedMarkingsSnapshot,
  type AppliedSeal,
  appliedLinkKey,
  NO_APPLIED_MARKINGS,
} from "../security/applied-markings-snapshot"
import { missingClearanceRedactions } from "../security/redactions"
import type { Redactions } from "../security/types"

/**
 * The marked properties one reader cannot read, resolved once from its clearances.
 *
 * A property is readable when the reader clears every one of its markings. Unreadable properties
 * are omitted from rows and cannot be used to select, order, or aggregate objects.
 *
 * Markings a projection's applied dataset version still carries extend this: its properties keep
 * them, and an object type or link whose key column carries markings the reader lacks is
 * unreadable, like a type it has no view grant for.
 */
export interface PropertyClearance {
  /** What the reader cannot read on this object type; `undefined` when it reads every property. */
  hiddenProperties(objectTypeId: string): HiddenProperties | undefined
  /** First marking on the property that the reader is not cleared for. */
  missingMarking(objectTypeId: string, propertyId: string): string | undefined
  /** Why the reader cannot read this object type at all; `undefined` when it can. */
  unreadableType(objectTypeId: string): Unreadable | undefined
  /** Why the reader cannot read this link, keyed by its source type; `undefined` when it can. */
  unreadableLink(objectTypeId: string, linkId: string): Unreadable | undefined
  /** Every object type and link the reader cannot read, for link queries that name none. */
  unreadable(): UnreadableTargets
}

/** A marking the reader lacks on what makes an object type or link unreadable, and why. */
export interface Unreadable {
  readonly marking: string
  readonly message: string
}

export interface UnreadableTargets {
  readonly types: ReadonlyMap<string, Unreadable>
  readonly links: readonly (Unreadable & {
    readonly objectTypeId: string
    readonly linkId: string
    readonly targetObjectTypeId: string
  })[]
}

/** The error a read of an unreadable object type or link fails with: a 403. */
export function unreadableError(unreadable: Unreadable): AuthorizationError {
  return new AuthorizationError(`clearance:marking:${unreadable.marking}`, unreadable.message)
}

/**
 * The properties of one object type a clearance set hides. It depends only on the type and the
 * clearances, so it is computed once and shared by every row and event redacted with it.
 */
export interface HiddenProperties {
  readonly ids: ReadonlySet<string>
  /**
   * The `redactions` record of a redacted row or event. It lists every hidden property, whether or
   * not a row holds a value: listing only present values would reveal which ones are empty.
   *
   * Deeply frozen, because every redacted row and event shares it.
   */
  readonly redactions: Redactions
}

// Readers are built per execution, but few distinct clearance sets exist per ontology.
const clearancesByOntology = new WeakMap<
  OntologyDefinitionCatalog,
  Map<string, PropertyClearance | undefined>
>()
// Applied markings change rarely, and a snapshot is replaced only when its content changes.
const appliedClearancesByOntology = new WeakMap<
  OntologyDefinitionCatalog,
  WeakMap<AppliedMarkingsSnapshot, Map<string, PropertyClearance | undefined>>
>()

const NO_UNREADABLE_TARGETS: UnreadableTargets = Object.freeze({
  types: new Map(),
  links: Object.freeze([]),
})

/**
 * Resolve what a reader with these clearances cannot read. Returns `undefined` when it can read
 * every property, so callers skip redaction entirely.
 *
 * A reader cleared for every marking the applied versions add receives the clearance of the code
 * alone, the same object whatever the snapshot.
 */
export function resolvePropertyClearance(
  ontology: OntologyDefinitionCatalog,
  clearances: ReadonlySet<string>,
  applied: AppliedMarkingsSnapshot = NO_APPLIED_MARKINGS
): PropertyClearance | undefined {
  const key = JSON.stringify([...clearances].sort())

  if (applied === NO_APPLIED_MARKINGS || clearsEvery(clearances, applied.markings)) {
    let resolved = clearancesByOntology.get(ontology)
    if (!resolved) {
      resolved = new Map()
      clearancesByOntology.set(ontology, resolved)
    }

    if (!resolved.has(key)) resolved.set(key, createPropertyClearance(ontology, clearances))
    return resolved.get(key)
  }

  let bySnapshot = appliedClearancesByOntology.get(ontology)
  if (!bySnapshot) {
    bySnapshot = new WeakMap()
    appliedClearancesByOntology.set(ontology, bySnapshot)
  }

  let resolved = bySnapshot.get(applied)
  if (!resolved) {
    resolved = new Map()
    bySnapshot.set(applied, resolved)
  }

  if (!resolved.has(key)) {
    resolved.set(key, createPropertyClearance(ontology, clearances, applied))
  }
  return resolved.get(key)
}

function clearsEvery(clearances: ReadonlySet<string>, markings: ReadonlySet<string>): boolean {
  for (const markingId of markings) if (!clearances.has(markingId)) return false
  return true
}

function createPropertyClearance(
  ontology: OntologyDefinitionCatalog,
  clearances: ReadonlySet<string>,
  applied: AppliedMarkingsSnapshot = NO_APPLIED_MARKINGS
): PropertyClearance | undefined {
  const missingByType = new Map<string, ReadonlyMap<string, string>>()
  const hiddenByType = new Map<string, HiddenProperties>()
  for (const objectType of ontology.listObjectTypes()) {
    const surplus = applied.properties.get(objectType.id)
    const missing = new Map<string, string>()
    for (const property of objectType.properties) {
      const marking =
        property.markings?.find((markingId) => !clearances.has(markingId)) ??
        firstMissing(surplus?.get(property.id), clearances)
      if (marking !== undefined) missing.set(property.id, marking)
    }

    if (missing.size === 0) continue

    missingByType.set(objectType.id, missing)
    hiddenByType.set(
      objectType.id,
      Object.freeze({
        ids: new Set(missing.keys()),
        redactions: missingClearanceRedactions(missing.keys()),
      })
    )
  }

  const types = new Map<string, Unreadable>()
  for (const [objectTypeId, seals] of applied.types) {
    const unreadable = unreadableBy(seals, clearances, `'${objectTypeId}'`)
    if (unreadable) types.set(objectTypeId, unreadable)
  }

  const links: UnreadableTargets["links"][number][] = []
  const linksByKey = new Map<string, Unreadable>()
  for (const [key, link] of applied.links) {
    const name = `link '${link.objectTypeId}.${link.linkId}'`
    const unreadable = unreadableBy(link.seals, clearances, name)
    if (!unreadable) continue

    linksByKey.set(key, unreadable)
    links.push(
      Object.freeze({
        ...unreadable,
        objectTypeId: link.objectTypeId,
        linkId: link.linkId,
        targetObjectTypeId: link.targetObjectTypeId,
      })
    )
  }

  if (hiddenByType.size === 0 && types.size === 0 && links.length === 0) return undefined

  const unreadable: UnreadableTargets =
    types.size === 0 && links.length === 0
      ? NO_UNREADABLE_TARGETS
      : Object.freeze({ types, links: Object.freeze(links) })
  return Object.freeze({
    hiddenProperties: (objectTypeId: string) => hiddenByType.get(objectTypeId),
    missingMarking: (objectTypeId: string, propertyId: string) =>
      missingByType.get(objectTypeId)?.get(propertyId),
    unreadableType: (objectTypeId: string) => types.get(objectTypeId),
    unreadableLink: (objectTypeId: string, linkId: string) =>
      linksByKey.get(appliedLinkKey(objectTypeId, linkId)),
    unreadable: () => unreadable,
  })
}

function firstMissing(
  markings: ReadonlySet<string> | undefined,
  clearances: ReadonlySet<string>
): string | undefined {
  if (!markings) return undefined
  for (const markingId of [...markings].sort()) if (!clearances.has(markingId)) return markingId
  return undefined
}

/** The first seal the reader lacks a marking for, as the message a denied read returns. */
function unreadableBy(
  seals: readonly AppliedSeal[],
  clearances: ReadonlySet<string>,
  name: string
): Unreadable | undefined {
  for (const seal of seals) {
    const marking = firstMissing(seal.markings, clearances)
    if (marking === undefined) continue
    return Object.freeze({
      marking,
      message: `[Sixb] Cannot read ${name} until projection '${seal.projectionId}' applies a compliant version: ${seal.reason} carries marking '${marking}'.`,
    })
  }
  return undefined
}
