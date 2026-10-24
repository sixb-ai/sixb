import type {
  AuthorizedObjectReader,
  ReaderViewCondition,
} from "../execution/authorized-object-reader"
import type { Clearance } from "../execution/object-reader-clearance"
import { type ObjectKey, visibleObjects } from "../execution/visible-objects"
import { matchesPredicate } from "../objects/query/matches-predicate"
import { type ObjectBatchKey, objectBatchKey } from "../storage"
import type { PropertyChangeMap } from "./property-changes"
import type {
  StoredDomainEvent,
  StoredObjectDeletedEvent,
  StoredObjectMutationEvent,
} from "./types"

/** Decided from the state the event carries, or by whether the reader sees the objects it names. */
type Decision = boolean | { readonly named: readonly ObjectKey[] }

/** Where the state of an object that no longer exists is found. */
export interface ObjectHistory {
  /** The objects among these that exist, whoever may see them. */
  existing(objects: readonly ObjectKey[]): Promise<ReadonlySet<ObjectBatchKey>>

  /** The last event of an object before this event, or undefined when the log keeps none. */
  lastEventBefore(
    event: StoredDomainEvent,
    object: ObjectKey
  ): Promise<StoredObjectMutationEvent | StoredObjectDeletedEvent | undefined>
}

/**
 * The events, in order, whose objects a reader sees under the conditions it views their types
 * through. An event that names no conditioned type passes: its grants decided it.
 *
 * - An object's creation or update is decided on the state it carries, its deletion on the last
 *   state the object held.
 * - Link events, telemetry and rule transitions carry no state to decide on. The objects they name
 *   of a conditioned type are read through the reader as they are now, in one call for the batch.
 * - One that no longer exists is decided on the state it held when the event happened, from its
 *   last event before it. A reader who saw an object is told what its deletion removed, and
 *   one who never saw it is told nothing, as for a hidden object.
 */
export async function visibleUnderConditions(
  reader: AuthorizedObjectReader,
  events: readonly StoredDomainEvent[],
  conditions: ReadonlyMap<string, ReaderViewCondition>,
  clearanceFor: (event: StoredDomainEvent) => Clearance,
  history: ObjectHistory
): Promise<readonly StoredDomainEvent[]> {
  if (conditions.size === 0) return events

  const decisions = events.map((event) => decide(event, conditions, clearanceFor(event)))

  const named = decisions.flatMap((decision) =>
    typeof decision === "boolean" ? [] : decision.named
  )
  const seenNow = await visibleObjects(reader, named)
  const seenThen = await seenBeforeDeletion(events, decisions, seenNow, conditions, history)

  return events.filter((_, index) => {
    const decision = decisions[index]!
    if (typeof decision === "boolean") return decision

    return decision.named.every((object) => {
      const key = objectBatchKey(object.objectTypeId, object.primaryId)
      return seenNow.has(key) || seenThen.has(eventObjectKey(index, key))
    })
  })
}

/**
 * Among the objects the reader does not see now, those that no longer exist and that it saw when
 * the event naming them happened, keyed by {@link eventObjectKey}.
 *
 * One that still exists is hidden, and its events with it. Only the others are looked up in the
 * log, so a reader pays for it only when an event names an object since deleted.
 */
async function seenBeforeDeletion(
  events: readonly StoredDomainEvent[],
  decisions: readonly Decision[],
  seenNow: ReadonlySet<ObjectBatchKey>,
  conditions: ReadonlyMap<string, ReaderViewCondition>,
  history: ObjectHistory
): Promise<ReadonlySet<string>> {
  const unseen = decisions.flatMap((decision, index) =>
    typeof decision === "boolean"
      ? []
      : decision.named
          .map((object) => ({
            index,
            object,
            key: objectBatchKey(object.objectTypeId, object.primaryId),
          }))
          .filter(({ key }) => !seenNow.has(key))
  )
  if (unseen.length === 0) return new Set()

  const unique = new Map(unseen.map(({ object, key }) => [key, object]))
  const existing = await history.existing([...unique.values()])
  const deleted = unseen.filter(({ key }) => !existing.has(key))

  const seenThen = await Promise.all(
    deleted.map(async ({ index, object }) => {
      const last = await history.lastEventBefore(events[index]!, object)
      if (!last) return false

      const properties =
        last.type === "object.deleted"
          ? lastState(last.payload.propertyChanges)
          : last.payload.properties

      return matchesPredicate({ properties }, conditions.get(object.objectTypeId)!.predicate)
    })
  )

  return new Set(
    deleted.flatMap(({ index, key }, at) => (seenThen[at] ? [eventObjectKey(index, key)] : []))
  )
}

/** An object as one event of the batch names it. */
function eventObjectKey(index: number, key: ObjectBatchKey): string {
  return `${index}\u0000${key}`
}

function decide(
  event: StoredDomainEvent,
  conditions: ReadonlyMap<string, ReaderViewCondition>,
  clearance: Clearance
): Decision {
  switch (event.topic) {
    case "objects": {
      const condition = conditions.get(event.payload.objectTypeId)
      if (!condition) return true
      if (condition.hiddenBy(clearance)) return false

      const properties =
        event.type === "object.deleted"
          ? lastState(event.payload.propertyChanges)
          : event.payload.properties

      // The object is visible in the state the event carries. An update after which it no longer
      // is delivers nothing: the reader's copy stays stale until it reads the object again.
      return matchesPredicate({ properties }, condition.predicate)
    }

    case "links": {
      const { sourceTypeId, sourceId, targetTypeId, targetId } = event.payload
      return namedObjects(conditions, clearance, [
        { objectTypeId: sourceTypeId, primaryId: sourceId },
        { objectTypeId: targetTypeId, primaryId: targetId },
      ])
    }

    case "telemetry": {
      const { objectTypeId, objectId } = event.payload
      return namedObjects(conditions, clearance, [{ objectTypeId, primaryId: objectId }])
    }

    case "rules": {
      const { objectTypeId, primaryId } = event.payload.subject
      return namedObjects(conditions, clearance, [{ objectTypeId, primaryId }])
    }

    default:
      return true
  }
}

/**
 * An update shown to a reader who could not see the object before it: what the object held then
 * is not this reader's to know. Decided on the event as stored, applied to the event as shown.
 *
 * Each change then reads as the object appearing with its new value. A property the update cleared
 * did not exist for this reader, so its change is left out.
 */
export function withoutHiddenPriorState(
  stored: StoredDomainEvent,
  shown: StoredDomainEvent,
  conditions: ReadonlyMap<string, ReaderViewCondition>
): StoredDomainEvent {
  if (stored.type !== "object.updated" || shown.type !== "object.updated") return shown

  const condition = conditions.get(stored.payload.objectTypeId)
  if (!condition) return shown

  const prior = priorState(stored.payload.properties, stored.payload.propertyChanges)
  if (matchesPredicate({ properties: prior }, condition.predicate)) return shown

  const propertyChanges = Object.fromEntries(
    Object.entries(shown.payload.propertyChanges).flatMap(([propertyId, change]) =>
      change.operation === "cleared"
        ? []
        : [[propertyId, { operation: "created" as const, after: change.after }]]
    )
  )

  return { ...shown, payload: { ...shown.payload, propertyChanges } }
}

/** The properties an object held before an update, from its new state and what changed. */
function priorState(
  properties: Readonly<Record<string, unknown>>,
  changes: PropertyChangeMap
): Record<string, unknown> {
  const prior: Record<string, unknown> = { ...properties }

  for (const [propertyId, change] of Object.entries(changes)) {
    if (change.operation === "created") delete prior[propertyId]
    else prior[propertyId] = change.before
  }

  return prior
}

/** The objects of a conditioned type among these, which the reader must see. */
function namedObjects(
  conditions: ReadonlyMap<string, ReaderViewCondition>,
  clearance: Clearance,
  objects: readonly ObjectKey[]
): Decision {
  const conditioned = objects.filter((object) => conditions.has(object.objectTypeId))
  if (conditioned.length === 0) return true

  if (conditioned.some((object) => conditions.get(object.objectTypeId)!.hiddenBy(clearance))) {
    return false
  }

  return { named: conditioned }
}

/** A deletion records every property the object held as cleared, with the value it had. */
function lastState(changes: PropertyChangeMap): Record<string, unknown> {
  const properties: Record<string, unknown> = {}

  for (const [propertyId, change] of Object.entries(changes)) {
    if (change.operation !== "created") properties[propertyId] = change.before
  }

  return properties
}
