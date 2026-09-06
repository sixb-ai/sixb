import { type AgentDefinition, AgentDefinitionError } from "@sixb/core"
import {
  defineLanguageModel,
  type LanguageModel,
  type LanguageModelDefinition,
  ModelCatalogUnavailableError,
} from "@sixb/core/models"

const DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS = 128_000

export interface AgentContextBudget {
  readonly windowTokens: number
  readonly inputBudgetTokens: number
  readonly reserveTokens: number
  readonly keepRecentTokens: number
  readonly source: "config" | "model" | "fallback"
}

type ContextAgent = Pick<AgentDefinition, "id" | "model" | "loop" | "reasoning">

/** Keep the exact resolved binding beside the budget derived from it. */
export async function prepareAgentModels(agents: readonly ContextAgent[]): Promise<{
  readonly models: ReadonlyMap<string, LanguageModel>
  readonly budgets: ReadonlyMap<string, AgentContextBudget>
}> {
  const models = new Map<string, LanguageModel>()
  const definitions = new Map<LanguageModel, Promise<LanguageModel>>()
  const localDefinitions = new Map<LanguageModel, Promise<LanguageModel>>()
  const warnedModels = new Set<string>()
  const snapshot = (model: LanguageModel, offline: boolean): Promise<LanguageModel> => {
    const snapshots = offline ? localDefinitions : definitions
    let pending = snapshots.get(model)
    if (!pending) {
      pending = Promise.resolve()
        .then(() => model.resolve?.({ offline }) ?? model)
        .catch((cause: unknown) => {
          if (offline || !(cause instanceof ModelCatalogUnavailableError)) throw cause
          return snapshot(model, true)
        })
      snapshots.set(model, pending)
    }
    return pending
  }
  const entries = await Promise.all(
    agents.map(async (agent) => {
      const offline =
        agent.loop?.context?.windowTokens !== undefined || hasContextLimit(agent.model.definition)
      const model = await snapshot(agent.model, offline)
      const definition = defineLanguageModel(model.definition)
      if (
        definition.providerId !== agent.model.providerId ||
        definition.modelId !== agent.model.modelId ||
        model.providerId !== agent.model.providerId ||
        model.modelId !== agent.model.modelId
      ) {
        throw invalidBudget(agent.id, "resolved model identity does not match the selected model.")
      }
      const budget = resolveAgentContextBudget(agent, definition)
      const modelRef = `${model.providerId}/${model.modelId}`
      if (budget.source === "fallback" && !warnedModels.has(modelRef)) {
        warnedModels.add(modelRef)
        console.warn(
          `[SixbAgentWorker] No context limit is available for '${modelRef}'; using the ${DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS.toLocaleString("en-US")}-token fallback. Configure loop.context.windowTokens to override it.`
        )
      }
      const maxOutputTokens = Math.min(
        budget.reserveTokens,
        model.definition.maxOutputTokens ?? budget.reserveTokens
      )
      if (typeof agent.reasoning === "object" && agent.reasoning.budgetTokens >= maxOutputTokens) {
        throw invalidBudget(agent.id, "output allowance must exceed the reasoning token budget.")
      }
      models.set(
        agent.id,
        Object.freeze({
          providerId: model.providerId,
          modelId: model.modelId,
          definition: defineLanguageModel({ ...model.definition, maxOutputTokens }),
          costEstimator: model.costEstimator,
          stream: (request: Parameters<LanguageModel["stream"]>[0]) =>
            model.stream({
              ...request,
              maxOutputTokens: Math.min(
                request.maxOutputTokens ?? maxOutputTokens,
                maxOutputTokens
              ),
            }),
        })
      )
      return [agent.id, budget] as const
    })
  )
  return { models, budgets: new Map(entries) }
}

function hasContextLimit(definition: LanguageModelDefinition): boolean {
  return definition.contextWindow !== undefined || definition.maxInputTokens !== undefined
}

/** Input-only limits are a conservative window: leave the same reserve without inventing a total. */
export function resolveAgentContextBudget(
  agent: ContextAgent,
  definition: LanguageModelDefinition = agent.model.definition
): AgentContextBudget {
  const config = agent.loop?.context
  const configuredWindow = config?.windowTokens
  const modelWindow = definition.contextWindow ?? definition.maxInputTokens
  const windowTokens = configuredWindow ?? modelWindow ?? DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS
  const reserveTokens =
    config?.reserveTokens ??
    Math.max(
      Math.min(16_384, Math.floor(windowTokens * 0.25)),
      typeof agent.reasoning === "object" ? agent.reasoning.budgetTokens + 1 : 0
    )

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
    source:
      configuredWindow !== undefined ? "config" : modelWindow === undefined ? "fallback" : "model",
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
