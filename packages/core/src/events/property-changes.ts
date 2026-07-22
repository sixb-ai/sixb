import { jsonValuesEqual } from "../json"

export type PropertyChangeOperation = "created" | "updated" | "cleared"

export type PropertyChange<TValue = unknown> =
  | { readonly operation: "created"; readonly after: TValue }
  | { readonly operation: "updated"; readonly before: TValue; readonly after: TValue }
  | { readonly operation: "cleared"; readonly before: TValue; readonly after: null }

export type PropertyChangeMap<TValue = unknown> = Record<string, PropertyChange<TValue>>

export function hasPropertyChanges(changes: PropertyChangeMap): boolean {
  return Object.keys(changes).length > 0
}

export function diffPropertyChanges(
  before: Record<string, unknown> | undefined,
  afterPatch: Record<string, unknown> | undefined
): PropertyChangeMap {
  if (!afterPatch) {
    return {}
  }

  const changes: Record<string, PropertyChange> = {}

  for (const [propertyId, after] of Object.entries(afterPatch)) {
    const hasBefore = before !== undefined && Object.hasOwn(before, propertyId)
    const beforeValue = hasBefore ? before[propertyId] : undefined

    if (hasBefore && jsonValuesEqual(beforeValue, after)) {
      continue
    }

    if (!hasBefore) {
      changes[propertyId] = { operation: "created", after }
      continue
    }

    if (after === null) {
      changes[propertyId] = { operation: "cleared", before: beforeValue, after: null }
      continue
    }

    changes[propertyId] = { operation: "updated", before: beforeValue, after }
  }

  return changes
}

export function clearedPropertyChanges(
  before: Record<string, unknown> | undefined
): PropertyChangeMap {
  if (!before) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(before).map(([propertyId, beforeValue]) => [
      propertyId,
      { operation: "cleared", before: beforeValue, after: null },
    ])
  )
}
