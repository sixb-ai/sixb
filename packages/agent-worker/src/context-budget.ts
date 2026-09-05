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
  return (await prepareAgentModels(agents)).budgets
}

/** Keep the exact resolved binding beside the budget derived from it. */
export async function prepareAgentModels(agents: readonly ContextAgent[]): Promise<{
  readonly models: ReadonlyMap<string, LanguageModel>
  readonly budgets: ReadonlyMap<string, AgentContextBudget>
}> {
  const models = new Map<string, LanguageModel>()
  const definitions = new Map<LanguageModel, Promise<LanguageModel>>()
  const localDefinitions = new Map<LanguageModel, Promise<LanguageModel>>()
  const entries = await Promise.all(
    agents.map(async (agent) => {
      const offline =
        agent.loop?.context?.windowTokens !== undefined || hasContextLimit(agent.model.definition)
      const snapshots = offline ? localDefinitions : definitions
      let model: LanguageModel
      try {
        let pending = snapshots.get(agent.model)
        if (!pending) {
          pending = resolveModelSnapshot(agent.model, offline)
          snapshots.set(agent.model, pending)
        }
        model = await pending
        const definition = defineLanguageModel(model.definition)
        if (
          definition.providerId !== agent.model.providerId ||
          definition.modelId !== agent.model.modelId
        ) {
          throw new TypeError("Provider metadata does not match the selected model.")
        }
        if (model.providerId !== agent.model.providerId || model.modelId !== agent.model.modelId) {
          throw new TypeError("Resolved model does not match the requested model.")
        }
      } catch (cause) {
        const error = missingContextLimit(agent)
        error.cause = cause
        throw error
      }
      models.set(agent.id, model)
      return [agent.id, resolveAgentContextBudget(agent, model.definition)] as const
    })
  )
  return { models, budgets: new Map(entries) }
}

async function resolveModelSnapshot(
  model: LanguageModel,
  offline: boolean
): Promise<LanguageModel> {
  if (model.resolve) return model.resolve({ offline })
  const definition = defineLanguageModel(
    offline ? model.definition : ((await model.resolveDefinition?.()) ?? model.definition)
  )
  // Custom models can keep the older metadata hook. Bind their stream receiver and enforce the
  // resolved output ceiling without mutating the original executable object.
  return Object.freeze({
    providerId: model.providerId,
    modelId: model.modelId,
    definition,
    costTracking: model.costTracking,
    stream: (request: Parameters<LanguageModel["stream"]>[0]) =>
      model.stream({
        ...request,
        ...(definition.maxOutputTokens === undefined
          ? {}
          : {
              maxOutputTokens: Math.min(
                request.maxOutputTokens ?? definition.maxOutputTokens,
                definition.maxOutputTokens
              ),
            }),
      }),
    resolveDefinition: async () => definition,
  })
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
