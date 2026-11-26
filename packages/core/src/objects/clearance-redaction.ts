import type { StoredDomainEvent } from "../events/types"
import type { ExpandedLinkValue, ExpandedObjectRow, ObjectRow } from "../storage"
import type { PropertyClearance, ReadableProperties } from "./property-clearance"

/**
 * Keep only the readable properties of a row and the objects expanded under it, and list the
 * hidden ones in `redactions`. The row is not modified: what changes is copied, the rest is shared.
 */
export function redactObjectRow<TRow extends ObjectRow>(
  row: TRow,
  readable: ReadableProperties
): TRow {
  return redactRow(row, readable, true)
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
  readable: ReadableProperties
): TRow {
  return redactRow(row, readable, false)
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
  readable: ReadableProperties,
  withRedactions: boolean
): TRow {
  const hidden = readable.hiddenProperties(row.objectTypeId)
  const properties = readableOnly(row.properties, readable.ids(row.objectTypeId))
  const links = row.links
  if (properties === row.properties && hidden === undefined && links === undefined) return row

  const redacted: TRow = { ...row, properties }
  if (hidden !== undefined && withRedactions) redacted.redactions = hidden.redactions

  if (links !== undefined) {
    redacted.links = Object.fromEntries(
      Object.entries(links).map(([linkId, value]) => [
        linkId,
        redactLinkValue(value, readable, withRedactions),
      ])
    )
  }
  return redacted
}

function redactLinkValue(
  value: ExpandedLinkValue,
  readable: ReadableProperties,
  withRedactions: boolean
): ExpandedLinkValue {
  if (value === null) return null
  if (Array.isArray(value)) {
    return value.map((row) => redactRow(row, readable, withRedactions))
  }

  // Array.isArray does not narrow a readonly[] away, so assert the single-object case.
  return redactRow(value as ExpandedObjectRow, readable, withRedactions)
}

/**
 * Keep only the readable properties of an object event, under the same contract as rows. Other
 * events carry no markable value: link properties and telemetry properties cannot be marked.
 */
export function redactDomainEvent(
  event: StoredDomainEvent,
  readable: ReadableProperties
): StoredDomainEvent {
  if (event.topic !== "objects") return event

  const objectTypeId = event.payload.objectTypeId
  const ids = readable.ids(objectTypeId)
  const hidden = readable.hiddenProperties(objectTypeId)
  const redactions = hidden === undefined ? {} : { redactions: hidden.redactions }

  const propertyChanges = readableOnly(event.payload.propertyChanges, ids)
  const changesKept = propertyChanges === event.payload.propertyChanges

  if (event.type === "object.deleted") {
    if (changesKept && hidden === undefined) return event

    return { ...event, payload: { ...event.payload, propertyChanges, ...redactions } }
  }

  const properties = readableOnly(event.payload.properties, ids)
  if (changesKept && properties === event.payload.properties && hidden === undefined) return event

  return { ...event, payload: { ...event.payload, properties, propertyChanges, ...redactions } }
}

/**
 * The record's own keys the reader may read: the record itself when it holds no other, so a row of
 * declared, readable properties is not copied.
 *
 * Spreading the record and deleting the few other keys is several times faster than assigning
 * each kept key, and the spread defines every key as an own property, even `__proto__`.
 */
export function readableOnly<TValue>(
  record: Readonly<Record<string, TValue>>,
  readable: ReadonlySet<string>
): Readonly<Record<string, TValue>> {
  const others = Object.keys(record).filter((key) => !readable.has(key))
  if (others.length === 0) return record

  const kept: Record<string, TValue> = { ...record }
  for (const key of others) delete kept[key]
  return kept
}
