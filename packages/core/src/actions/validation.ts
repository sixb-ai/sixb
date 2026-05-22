import { ActionDefinitionError } from "./errors"
import type { ActionDefinition } from "./types"

export function assertNonEmpty(value: string, field: string): void {
  if (!value.trim()) {
    throw new ActionDefinitionError(`Action ${field} must not be empty.`)
  }
}

export function isActionDefinition(value: unknown): value is ActionDefinition {
  return (
    typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "action"
  )
}
