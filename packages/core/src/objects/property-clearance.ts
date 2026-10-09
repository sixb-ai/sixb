import { AuthorizationError } from "../authorization/errors"
import type { StoredDomainEvent } from "../events/types"
import type { OntologyDefinitionCatalog } from "../ontology/registry"
import type { ExpandedLinkValue, ExpandedObjectRow, ObjectRedactions, ObjectRow } from "../storage"
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
  /** Marked properties of this object type the reader cannot read. */
  hiddenPropertyIds(objectTypeId: string): ReadonlySet<string>
  /** First marking on the property that the reader is not cleared for. */
  missingMarking(objectTypeId: string, propertyId: string): string | undefined
}

const NO_PROPERTIES: ReadonlySet<string> = new Set()

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
  for (const objectType of ontology.listObjectTypes()) {
    const missing = new Map<string, string>()
    for (const property of objectType.properties) {
      const marking = property.markings?.find((markingId) => !clearances.has(markingId))
      if (marking !== undefined) missing.set(property.id, marking)
    }
    if (missing.size > 0) missingByType.set(objectType.id, missing)
  }
  if (missingByType.size === 0) return undefined

  const hiddenByType = new Map(
    [...missingByType].map(([objectTypeId, missing]) => [objectTypeId, new Set(missing.keys())])
  )
  return Object.freeze({
    hiddenPropertyIds: (objectTypeId: string) => hiddenByType.get(objectTypeId) ?? NO_PROPERTIES,
    missingMarking: (objectTypeId: string, propertyId: string) =>
      missingByType.get(objectTypeId)?.get(propertyId),
  })
}

/**
 * Omit unreadable properties from a row and the objects expanded under it.
 *
 * Every hidden property of the type is listed in `redactions`, whether or not the row holds a
 * value: listing only present values would reveal which hidden properties are empty.
 */
export function redactObjectRow<TRow extends ObjectRow>(
  row: TRow,
  clearance: PropertyClearance
): TRow {
  const hidden = clearance.hiddenPropertyIds(row.objectTypeId)
  const links = row.links
  if (hidden.size === 0 && links === undefined) return row

  const redacted: TRow = { ...row }
  if (hidden.size > 0) {
    redacted.properties = withoutKeys(row.properties, hidden)
    redacted.redactions = redactionsFor(hidden)
  }
  if (links !== undefined) {
    redacted.links = Object.fromEntries(
      Object.entries(links).map(([linkId, value]) => [linkId, redactLinkValue(value, clearance)])
    )
  }
  return redacted
}

function redactLinkValue(
  value: ExpandedLinkValue,
  clearance: PropertyClearance
): ExpandedLinkValue {
  if (value === null) return null
  if (Array.isArray(value)) return value.map((row) => redactObjectRow(row, clearance))
  // Array.isArray does not narrow a readonly[] away, so assert the single-object case.
  return redactObjectRow(value as ExpandedObjectRow, clearance)
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
  const hidden = clearance.hiddenPropertyIds(event.payload.objectTypeId)
  if (hidden.size === 0) return event

  const payload = {
    ...event.payload,
    propertyChanges: withoutKeys(event.payload.propertyChanges, hidden),
    redactions: redactionsFor(hidden),
  }
  if (event.type === "object.deleted") return { ...event, payload }
  return {
    ...event,
    payload: { ...payload, properties: withoutKeys(event.payload.properties, hidden) },
  }
}

function redactionsFor(hidden: ReadonlySet<string>): ObjectRedactions {
  return Object.fromEntries(
    [...hidden].map((propertyId) => [propertyId, { reason: "missing_clearance" }] as const)
  )
}

function withoutKeys<TValue>(
  record: Readonly<Record<string, TValue>>,
  hidden: ReadonlySet<string>
): Record<string, TValue> {
  const kept: Record<string, TValue> = {}
  for (const [key, value] of Object.entries(record)) {
    if (!hidden.has(key)) kept[key] = value
  }
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
