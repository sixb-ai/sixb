import { AgentDefinitionError } from "./errors"
import type { AgentDefinition, AgentLoopConfig } from "./types"

export function assertNonEmpty(value: string, field: string): void {
  if (!value.trim()) {
    throw new AgentDefinitionError(`[Sixb] Agent ${field} must not be empty.`)
  }
}

export function isAgentDefinition(value: unknown): value is AgentDefinition {
  return (
    isRecord(value) &&
    value.kind === "agent" &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.instructions === "string"
  )
}

export function assertValidLoopConfig(loop: AgentLoopConfig | undefined): void {
  const maxSteps = loop?.stopWhen?.maxSteps
  if (maxSteps === undefined) {
    return
  }
  if (!Number.isInteger(maxSteps) || maxSteps <= 0) {
    throw new AgentDefinitionError(
      "[Sixb] Agent loop.stopWhen.maxSteps must be a positive finite integer."
    )
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
