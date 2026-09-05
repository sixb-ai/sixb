import { type AgentDefinition, AgentDefinitionError } from "@sixb/core"

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
  readonly source: "config" | "model" | "models.dev" | "fallback"
}

/** Resolve one agent's effective compaction budget from overrides, model limits, or fallback. */
export function resolveAgentContextBudget(
  agent: Pick<AgentDefinition, "id" | "model" | "loop">,
  modelLimits?: AgentModelContextLimits
): AgentContextBudget {
  const config = agent.loop?.context
  const configuredWindow = config?.windowTokens
  const modelWindow = agent.model.definition.contextWindow
  const discoveredLimits =
    configuredWindow === undefined
      ? modelWindow === undefined
        ? modelLimits
        : { contextTokens: modelWindow }
      : undefined
  const windowTokens =
    configuredWindow ?? discoveredLimits?.contextTokens ?? DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS
  const reserveTokens = config?.reserveTokens ?? Math.min(16_384, Math.floor(windowTokens * 0.25))

  assertPositiveSafeInteger(agent.id, windowTokens, "windowTokens")
  assertPositiveSafeInteger(agent.id, reserveTokens, "reserveTokens")
  if (reserveTokens >= windowTokens) {
    throw invalidBudget(agent.id, "reserveTokens must be less than the resolved context window.")
  }
  const inputBudgetTokens = Math.min(
    discoveredLimits?.inputTokens ?? Number.POSITIVE_INFINITY,
    windowTokens - reserveTokens
  )
  if (!Number.isSafeInteger(inputBudgetTokens) || inputBudgetTokens <= 0) {
    throw invalidBudget(agent.id, "the resolved input budget must be a positive safe integer.")
  }
  const keepRecentTokens =
    config?.keepRecentTokens ?? Math.min(20_000, Math.floor(inputBudgetTokens * 0.5))
  assertPositiveSafeInteger(agent.id, keepRecentTokens, "keepRecentTokens")
  if (keepRecentTokens >= inputBudgetTokens) {
    throw invalidBudget(agent.id, "keepRecentTokens must be less than the resolved input budget.")
  }

  return Object.freeze({
    windowTokens,
    inputBudgetTokens,
    reserveTokens,
    keepRecentTokens,
    source:
      configuredWindow !== undefined
        ? "config"
        : modelWindow !== undefined
          ? "model"
          : discoveredLimits === undefined
            ? "fallback"
            : "models.dev",
  })
}

function invalidBudget(agentId: string, message: string): AgentDefinitionError {
  return new AgentDefinitionError(`[SixbAgentWorker] Agent '${agentId}' context ${message}`)
}

function assertPositiveSafeInteger(agentId: string, value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalidBudget(agentId, `${field} must be a positive safe integer.`)
  }
}
