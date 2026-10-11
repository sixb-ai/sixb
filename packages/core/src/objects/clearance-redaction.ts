import type { StoredDomainEvent } from "../events/types"
import type { ExpandedLinkValue, ExpandedObjectRow, ObjectRow } from "../storage"
import type { PropertyClearance } from "./property-clearance"

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
