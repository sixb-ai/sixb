import { AuthorizationError } from "../authorization/errors"
import type { StoredDomainEvent } from "../events/types"
import type { OntologyDefinitionCatalog } from "../ontology/registry"
import { missingClearanceRedactions } from "../security/redactions"
import type { Redactions } from "../security/types"
import type { ExpandedLinkValue, ExpandedObjectRow, ObjectRow } from "../storage"
import type {
  ObjectQueryAdmissionState,
  ObjectQueryPropertyUse,
  ObjectQuerySemanticAdmission,
} from "./query/validate"

/**
 * The marked properties one reader cannot read, resolved once from its clearances.
 *
 * A property is readable when the reader clears every one of its markings. Unreadable properties
 * are omitted from rows and cannot be used to select, order, or aggregate objects.
 */
export interface PropertyClearance {
  /** What the reader cannot read on this object type; `undefined` when it reads every property. */
  hiddenProperties(objectTypeId: string): HiddenProperties | undefined
  /** First marking on the property that the reader is not cleared for. */
  missingMarking(objectTypeId: string, propertyId: string): string | undefined
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

/**
 * Resolve what a reader with these clearances cannot read. Returns `undefined` when it can read
 * every property, so callers skip redaction entirely.
 */
export function resolvePropertyClearance(
  ontology: OntologyDefinitionCatalog,
  clearances: ReadonlySet<string>
): PropertyClearance | undefined {
  let resolved = clearancesByOntology.get(ontology)
  if (!resolved) {
    resolved = new Map()
    clearancesByOntology.set(ontology, resolved)
  }
  const key = JSON.stringify([...clearances].sort())
  if (!resolved.has(key)) resolved.set(key, createPropertyClearance(ontology, clearances))
  return resolved.get(key)
}

function createPropertyClearance(
  ontology: OntologyDefinitionCatalog,
  clearances: ReadonlySet<string>
): PropertyClearance | undefined {
  const missingByType = new Map<string, ReadonlyMap<string, string>>()
  const hiddenByType = new Map<string, HiddenProperties>()
  for (const objectType of ontology.listObjectTypes()) {
    const missing = new Map<string, string>()
    for (const property of objectType.properties) {
      const marking = property.markings?.find((markingId) => !clearances.has(markingId))
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

  if (hiddenByType.size === 0) return undefined

  return Object.freeze({
    hiddenProperties: (objectTypeId: string) => hiddenByType.get(objectTypeId),
    missingMarking: (objectTypeId: string, propertyId: string) =>
      missingByType.get(objectTypeId)?.get(propertyId),
  })
}

/**
 * Omit unreadable properties from a row and the objects expanded under it, and list them in
 * `redactions`. The row is not modified: what changes is copied, the rest is shared.
 */
export function redactObjectRow<TRow extends ObjectRow>(
  row: TRow,
  clearance: PropertyClearance
): TRow {
  return redactRow(row, clearance, true)
}

/**
 * {@link redactObjectRow} without the `redactions` records, for rows about to be deep-copied.
 *
 * Omitting hidden values before the copy keeps them out of it and copies each row once. The copy
 * then receives its records from {@link attachRedactions}: they are frozen and owned by the
 * clearance, so they are shared rather than copied with each row.
 */
export function omitHiddenProperties<TRow extends ObjectRow>(
  row: TRow,
  clearance: PropertyClearance
): TRow {
  return redactRow(row, clearance, false)
}

/**
 * Set `redactions` on a row returned by {@link omitHiddenProperties} and since deep-copied, and on
 * the objects expanded under it. It modifies the row, so it only accepts the caller's own copy.
 */
export function attachRedactions(row: ObjectRow, clearance: PropertyClearance): void {
  const hidden = clearance.hiddenProperties(row.objectTypeId)
  if (hidden !== undefined) row.redactions = hidden.redactions

  if (row.links === undefined) return

  for (const value of Object.values(row.links)) {
    if (value === null) continue
    if (Array.isArray(value)) {
      for (const linked of value) attachRedactions(linked, clearance)
    } else {
      attachRedactions(value as ExpandedObjectRow, clearance)
    }
  }
}

function redactRow<TRow extends ObjectRow>(
  row: TRow,
  clearance: PropertyClearance,
  withRedactions: boolean
): TRow {
  const hidden = clearance.hiddenProperties(row.objectTypeId)
  const links = row.links
  if (hidden === undefined && links === undefined) return row

  const redacted: TRow = { ...row }
  if (hidden !== undefined) {
    redacted.properties = withoutKeys(row.properties, hidden.ids)
    if (withRedactions) redacted.redactions = hidden.redactions
  }
  if (links !== undefined) {
    redacted.links = Object.fromEntries(
      Object.entries(links).map(([linkId, value]) => [
        linkId,
        redactLinkValue(value, clearance, withRedactions),
      ])
    )
  }
  return redacted
}

function redactLinkValue(
  value: ExpandedLinkValue,
  clearance: PropertyClearance,
  withRedactions: boolean
): ExpandedLinkValue {
  if (value === null) return null
  if (Array.isArray(value)) {
    return value.map((row) => redactRow(row, clearance, withRedactions))
  }
  // Array.isArray does not narrow a readonly[] away, so assert the single-object case.
  return redactRow(value as ExpandedObjectRow, clearance, withRedactions)
}

/**
 * Omit unreadable properties from an object event, under the same contract as rows. Other events
 * carry no markable value: link properties and telemetry properties cannot be marked.
 */
export function redactDomainEvent(
  event: StoredDomainEvent,
  clearance: PropertyClearance
): StoredDomainEvent {
  if (event.topic !== "objects") return event
  const hidden = clearance.hiddenProperties(event.payload.objectTypeId)
  if (hidden === undefined) return event

  if (event.type === "object.deleted") {
    return {
      ...event,
      payload: {
        ...event.payload,
        propertyChanges: withoutKeys(event.payload.propertyChanges, hidden.ids),
        redactions: hidden.redactions,
      },
    }
  }

  return {
    ...event,
    payload: {
      ...event.payload,
      properties: withoutKeys(event.payload.properties, hidden.ids),
      propertyChanges: withoutKeys(event.payload.propertyChanges, hidden.ids),
      redactions: hidden.redactions,
    },
  }
}

/**
 * A copy of the record's own properties without the hidden keys.
 *
 * Spreading the record and deleting the few hidden keys is several times faster than assigning
 * each kept key, and the spread defines every key as an own property, even `__proto__`.
 */
function withoutKeys<TValue>(
  record: Readonly<Record<string, TValue>>,
  hidden: ReadonlySet<string>
): Record<string, TValue> {
  const kept: Record<string, TValue> = { ...record }
  for (const key of hidden) delete kept[key]
  return kept
}

/**
 * Reject every query use of a property the reader cannot read, except projection.
 *
 * Filtering, ordering, searching, or faceting by a hidden value would reveal it through which
 * objects match and in what order. Projection only shapes the output, which is redacted anyway.
 */
export function createClearanceQueryAdmission(
  clearance: PropertyClearance
): ObjectQuerySemanticAdmission {
  // Each state stands for the object types a query has reached so far. A property without an
  // explicit type is checked against all of them.
  const reachedTypes = new WeakMap<ObjectQueryAdmissionState, readonly string[]>()
  const state = (objectTypeIds: readonly string[]): ObjectQueryAdmissionState => {
    const created = Object.freeze({})
    reachedTypes.set(created, Object.freeze([...objectTypeIds]))
    return created
  }
  const reached = (input: ObjectQueryAdmissionState): readonly string[] => {
    const objectTypeIds = reachedTypes.get(input)
    if (!objectTypeIds) {
      throw new Error("[Sixb] Clearance query admission received a state it did not create.")
    }
    return objectTypeIds
  }
  const empty = state([])

  const admission: ObjectQuerySemanticAdmission = {
    empty: () => empty,
    source: (input) => ({ state: state(input.result.objectTypeIds) }),
    edge: (input) => ({ state: state(input.result.objectTypeIds) }),
    // A difference only returns objects of its first input.
    set: (input) =>
      input.op === "subtract"
        ? (input.states[0] ?? empty)
        : state([...new Set(input.states.flatMap(reached))]),
    property: (input) => {
      if (input.use === "project") return undefined
      const objectTypeIds =
        input.objectTypeId === undefined ? reached(input.state) : [input.objectTypeId]
      for (const objectTypeId of objectTypeIds) {
        const marking = clearance.missingMarking(objectTypeId, input.propertyId)
        if (marking === undefined) continue
        return new AuthorizationError(
          `clearance:marking:${marking}`,
          `[Sixb] Cannot ${PROPERTY_USE_VERBS[input.use]} '${objectTypeId}.${input.propertyId}' at '${input.path}': it requires clearance for marking '${marking}'.`
        )
      }
      return undefined
    },
  }
  return Object.freeze(admission)
}

const PROPERTY_USE_VERBS: Readonly<Record<ObjectQueryPropertyUse, string>> = {
  filter: "filter by",
  text: "search",
  vector: "run a vector search over",
  sort: "sort by",
  project: "project",
  "expand.orderBy": "order expanded objects by",
  facet: "facet by",
}
