import { AgentDefinitionError } from "@sixb/core"

export const DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS = 128_000

export interface AgentModelContextLimits {
  readonly contextTokens: number
  readonly inputTokens?: number
}

export interface AgentContextBudget {
  readonly windowTokens: number
  readonly inputBudgetTokens: number
  readonly reserveTokens: number
  readonly keepRecentTokens: number
  readonly source: "models.dev" | "fallback"
}

/** Resolve the compaction budget from model limits or the framework fallback. */
export function resolveAgentContextBudget(
  modelLimits?: AgentModelContextLimits
): AgentContextBudget {
  const discoveredLimits = modelLimits
  const windowTokens = discoveredLimits?.contextTokens ?? DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS
  const reserveTokens = Math.min(16_384, Math.floor(windowTokens * 0.25))

  assertPositiveSafeInteger(windowTokens, "windowTokens")
  assertPositiveSafeInteger(reserveTokens, "reserveTokens")
  if (reserveTokens >= windowTokens) {
    throw invalidBudget("reserveTokens must be less than the resolved context window.")
  }
  const inputBudgetTokens = Math.min(
    discoveredLimits?.inputTokens ?? Number.POSITIVE_INFINITY,
    windowTokens - reserveTokens
  )
  if (!Number.isSafeInteger(inputBudgetTokens) || inputBudgetTokens <= 0) {
    throw invalidBudget("the resolved input budget must be a positive safe integer.")
  }
  const keepRecentTokens = Math.min(20_000, Math.floor(inputBudgetTokens * 0.5))
  assertPositiveSafeInteger(keepRecentTokens, "keepRecentTokens")
  if (keepRecentTokens >= inputBudgetTokens) {
    throw invalidBudget("keepRecentTokens must be less than the resolved input budget.")
  }

  return Object.freeze({
    windowTokens,
    inputBudgetTokens,
    reserveTokens,
    keepRecentTokens,
    source: discoveredLimits === undefined ? "fallback" : "models.dev",
  })
}

function invalidBudget(message: string): AgentDefinitionError {
  return new AgentDefinitionError(`[SixbAgentWorker] Agent context ${message}`)
}

function assertPositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalidBudget(`${field} must be a positive safe integer.`)
  }
}
