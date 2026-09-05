import { type AgentDefinition, AgentDefinitionError } from "@sixb/core"
import {
  defineLanguageModel,
  type LanguageModel,
  type LanguageModelDefinition,
} from "@sixb/core/models"

export interface AgentContextBudget {
  readonly windowTokens: number
  readonly inputBudgetTokens: number
  readonly reserveTokens: number
  readonly keepRecentTokens: number
  readonly source: "config" | "model"
}

type ContextAgent = Pick<AgentDefinition, "id" | "model" | "loop">

/** Resolve provider metadata once per model instance, before the worker accepts any jobs. */
export async function resolveAgentContextBudgets(
  agents: readonly ContextAgent[]
): Promise<ReadonlyMap<string, AgentContextBudget>> {
  const definitions = new Map<LanguageModel, Promise<LanguageModelDefinition>>()
  const entries = await Promise.all(
    agents.map(async (agent) => {
      if (
        agent.loop?.context?.windowTokens !== undefined ||
        hasContextLimit(agent.model.definition)
      ) {
        return [agent.id, resolveAgentContextBudget(agent)] as const
      }
      let definition: LanguageModelDefinition
      try {
        let pending = definitions.get(agent.model)
        if (!pending) {
          pending = agent.model.resolveDefinition?.() ?? Promise.resolve(agent.model.definition)
          definitions.set(agent.model, pending)
        }
        definition = defineLanguageModel(await pending)
        if (
          definition.providerId !== agent.model.providerId ||
          definition.modelId !== agent.model.modelId
        ) {
          throw new TypeError("Provider metadata does not match the selected model.")
        }
      } catch (cause) {
        const error = missingContextLimit(agent)
        error.cause = cause
        throw error
      }
      return [agent.id, resolveAgentContextBudget(agent, definition)] as const
    })
  )
  return new Map(entries)
}

function hasContextLimit(definition: LanguageModelDefinition): boolean {
  return definition.contextWindow !== undefined || definition.maxInputTokens !== undefined
}

function missingContextLimit(agent: ContextAgent): AgentDefinitionError {
  return invalidBudget(
    agent.id,
    `limit could not be resolved for '${agent.model.providerId}/${agent.model.modelId}'. Configure loop.context.windowTokens or supply a model definition with contextWindow or maxInputTokens.`
  )
}

/** Input-only limits are a conservative window: leave the same reserve without inventing a total. */
export function resolveAgentContextBudget(
  agent: ContextAgent,
  definition: LanguageModelDefinition = agent.model.definition
): AgentContextBudget {
  const config = agent.loop?.context
  const configuredWindow = config?.windowTokens
  const windowTokens = configuredWindow ?? definition.contextWindow ?? definition.maxInputTokens
  if (windowTokens === undefined) throw missingContextLimit(agent)
  const reserveTokens = config?.reserveTokens ?? Math.min(16_384, Math.floor(windowTokens * 0.25))

  assertPositiveSafeInteger(agent.id, windowTokens, "windowTokens")
  assertPositiveSafeInteger(agent.id, reserveTokens, "reserveTokens")
  if (reserveTokens >= windowTokens) {
    throw invalidBudget(agent.id, "reserveTokens must be less than the resolved context window.")
  }
  const inputBudgetTokens = Math.min(
    configuredWindow === undefined
      ? (definition.maxInputTokens ?? Number.POSITIVE_INFINITY)
      : Number.POSITIVE_INFINITY,
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
    source: configuredWindow !== undefined ? "config" : "model",
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
