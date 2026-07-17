import { jsonValuesEqual } from "../json"

export type PropertyChangeOperation = "created" | "updated" | "cleared"

export type PropertyChange =
  | { readonly operation: "created"; readonly after: unknown }
  | { readonly operation: "updated"; readonly before: unknown; readonly after: unknown }
  | { readonly operation: "cleared"; readonly before: unknown; readonly after: null }

export type PropertyChangeMap = Record<string, PropertyChange>

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

  const changes: PropertyChangeMap = {}

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
