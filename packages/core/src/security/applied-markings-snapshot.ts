import type { ProjectionKeyTarget } from "./projection-markings"

/** Why readers lacking some markings cannot read an object type or a link. */
export interface AppliedSeal {
  readonly projectionId: string
  readonly markings: ReadonlySet<string>
  /** What carries the marking, completed by "carries marking 'm'" in messages. */
  readonly reason: string
}

export interface AppliedLinkSeals {
  readonly objectTypeId: string
  readonly linkId: string
  readonly targetObjectTypeId: string
  readonly seals: readonly AppliedSeal[]
}

export interface AppliedMarkingsNotice {
  readonly projectionId: string
  /** Whether the projection makes an object type or a link unreadable, not only properties. */
  readonly sealed: boolean
  readonly message: string
}

/**
 * What the applied versions add to the ontology's markings.
 *
 * Every reader of a host shares one snapshot and the clearances resolved for it, so a snapshot is
 * immutable all the way down: its maps and sets refuse writes.
 */
export interface AppliedMarkingsSnapshot {
  /** Surplus markings by object type, then property. */
  readonly properties: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>
  /** Object types readers lacking a seal's markings cannot read. */
  readonly types: ReadonlyMap<string, readonly AppliedSeal[]>
  /** Links, by {@link appliedLinkKey}, readers lacking a seal's markings cannot read. */
  readonly links: ReadonlyMap<string, AppliedLinkSeals>
  /** Every marking above: a reader cleared for all of them reads what the code allows. */
  readonly markings: ReadonlySet<string>
  /** One per projection whose applied version adds markings, for diagnostics. */
  readonly notices: readonly AppliedMarkingsNotice[]
}

export function appliedLinkKey(objectTypeId: string, linkId: string): string {
  return `${objectTypeId}\0${linkId}`
}

/** What one applied version adds, as plain data so that equal results serialize equally. */
export interface AppliedContribution {
  readonly properties: readonly {
    readonly objectTypeId: string
    readonly propertyId: string
    readonly markings: readonly string[]
  }[]
  readonly seals: readonly {
    readonly target: ProjectionKeyTarget
    readonly seal: {
      readonly projectionId: string
      readonly markings: readonly string[]
      readonly reason: string
    }
  }[]
  readonly notice?: AppliedMarkingsNotice
}

/** An applied version that adds nothing. */
export const NO_CONTRIBUTION: AppliedContribution = Object.freeze({
  properties: Object.freeze([]),
  seals: Object.freeze([]),
})

export const NO_APPLIED_MARKINGS: AppliedMarkingsSnapshot = Object.freeze({
  properties: readonlyMap(new Map()),
  types: readonlyMap(new Map()),
  links: readonlyMap(new Map()),
  markings: readonlySet(new Set<string>()),
  notices: Object.freeze([]),
})

/** One snapshot from the contributions of every applied version, in projection order. */
export function assembleAppliedMarkings(
  contributions: readonly AppliedContribution[]
): AppliedMarkingsSnapshot {
  if (contributions.length === 0) return NO_APPLIED_MARKINGS
  const properties = new Map<string, Map<string, Set<string>>>()
  const types = new Map<string, AppliedSeal[]>()
  const links = new Map<string, AppliedLinkSeals & { seals: AppliedSeal[] }>()
  const markings = new Set<string>()
  const notices: AppliedMarkingsNotice[] = []
  for (const contribution of contributions) {
    for (const { objectTypeId, propertyId, markings: added } of contribution.properties) {
      const byProperty = properties.get(objectTypeId) ?? new Map<string, Set<string>>()
      properties.set(objectTypeId, byProperty)
      const set = byProperty.get(propertyId) ?? new Set<string>()
      byProperty.set(propertyId, set)
      for (const markingId of added) {
        set.add(markingId)
        markings.add(markingId)
      }
    }
    for (const { target, seal: data } of contribution.seals) {
      const seal: AppliedSeal = Object.freeze({
        ...data,
        markings: readonlySet(new Set(data.markings)),
      })
      for (const markingId of data.markings) markings.add(markingId)
      if (target.kind === "type") {
        types.set(target.objectTypeId, [...(types.get(target.objectTypeId) ?? []), seal])
        continue
      }
      const key = appliedLinkKey(target.objectTypeId, target.linkId)
      const existing = links.get(key)
      if (existing) existing.seals.push(seal)
      else {
        links.set(key, {
          objectTypeId: target.objectTypeId,
          linkId: target.linkId,
          targetObjectTypeId: target.targetObjectTypeId,
          seals: [seal],
        })
      }
    }
    if (contribution.notice) notices.push(Object.freeze({ ...contribution.notice }))
  }
  return Object.freeze({
    properties: readonlyMap(
      new Map(
        [...properties].map(([objectTypeId, byProperty]) => [
          objectTypeId,
          readonlyMap(
            new Map([...byProperty].map(([propertyId, set]) => [propertyId, readonlySet(set)]))
          ),
        ])
      )
    ),
    types: readonlyMap(
      new Map([...types].map(([objectTypeId, seals]) => [objectTypeId, Object.freeze(seals)]))
    ),
    links: readonlyMap(
      new Map(
        [...links].map(([key, link]) => [
          key,
          Object.freeze({ ...link, seals: Object.freeze(link.seals) }),
        ])
      )
    ),
    markings: readonlySet(markings),
    notices: Object.freeze(notices),
  })
}

/**
 * The snapshot with these properties' markings added: what an object event reads under, given the
 * markings its origin version carries on them.
 */
export function withPropertyMarkings(
  snapshot: AppliedMarkingsSnapshot,
  added: AppliedContribution["properties"]
): AppliedMarkingsSnapshot {
  if (added.length === 0) return snapshot
  const properties = new Map<string, Map<string, Set<string>>>(
    [...snapshot.properties].map(([objectTypeId, byProperty]) => [
      objectTypeId,
      new Map([...byProperty].map(([propertyId, set]) => [propertyId, new Set(set)])),
    ])
  )
  const markings = new Set(snapshot.markings)
  for (const { objectTypeId, propertyId, markings: ids } of added) {
    const byProperty = properties.get(objectTypeId) ?? new Map<string, Set<string>>()
    properties.set(objectTypeId, byProperty)
    const set = byProperty.get(propertyId) ?? new Set<string>()
    byProperty.set(propertyId, set)
    for (const markingId of ids) {
      set.add(markingId)
      markings.add(markingId)
    }
  }
  return Object.freeze({
    ...snapshot,
    properties: readonlyMap(
      new Map(
        [...properties].map(([objectTypeId, byProperty]) => [
          objectTypeId,
          readonlyMap(
            new Map([...byProperty].map(([propertyId, set]) => [propertyId, readonlySet(set)]))
          ),
        ])
      )
    ),
    markings: readonlySet(markings),
  })
}

/**
 * A map that refuses writes. `Object.freeze` alone leaves a map's entries writable through its
 * methods, so they are shadowed by ones that throw, and then frozen.
 */
function readonlyMap<TKey, TValue>(map: Map<TKey, TValue>): ReadonlyMap<TKey, TValue> {
  return Object.freeze(
    Object.defineProperties(map, {
      set: { value: refuseWrite },
      delete: { value: refuseWrite },
      clear: { value: refuseWrite },
    })
  )
}

function readonlySet<TValue>(set: Set<TValue>): ReadonlySet<TValue> {
  return Object.freeze(
    Object.defineProperties(set, {
      add: { value: refuseWrite },
      delete: { value: refuseWrite },
      clear: { value: refuseWrite },
    })
  )
}

function refuseWrite(): never {
  throw new TypeError("[Sixb] Applied markings are immutable.")
}
