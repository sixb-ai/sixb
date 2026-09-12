import { AgentDefinitionError } from "@sixb/core"
import { resolveLanguageModel } from "@sixb/core/internal/model-execution"
import {
  defineLanguageModel,
  type LanguageModel,
  type LanguageModelDefinition,
  type ModelReasoning,
} from "@sixb/core/models"

const DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS = 128_000

export interface AgentContextBudget {
  readonly windowTokens: number
  readonly inputBudgetTokens: number
  readonly reserveTokens: number
  readonly keepRecentTokens: number
  readonly source: "model" | "fallback"
}

interface AgentModelSelection {
  readonly model: LanguageModel
  readonly reasoning?: ModelReasoning
}

/** Pin the selected model and derive its input/output budgets from the same metadata snapshot. */
export async function prepareAgentModel(selection: AgentModelSelection): Promise<{
  readonly model: LanguageModel
  readonly budget: AgentContextBudget
}> {
  const model = await resolveLanguageModel(selection.model)
  const definition = defineLanguageModel(model.definition)
  const budget = resolveAgentContextBudget({ model, reasoning: selection.reasoning }, definition)
  if (budget.source === "fallback") {
    console.warn(
      `[SixbAgentWorker] No context limit is available for '${model.providerId}/${model.modelId}'; using the ${DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS.toLocaleString("en-US")}-token fallback.`
    )
  }
  const maxOutputTokens = Math.min(
    budget.reserveTokens,
    definition.maxOutputTokens ?? budget.reserveTokens
  )
  if (
    typeof selection.reasoning === "object" &&
    selection.reasoning.budgetTokens >= maxOutputTokens
  ) {
    throw invalidBudget("output allowance must exceed the reasoning token budget.")
  }
  return {
    budget,
    model: Object.freeze({
      providerId: model.providerId,
      modelId: model.modelId,
      definition: defineLanguageModel({ ...definition, maxOutputTokens }),
      costEstimator: model.costEstimator,
      stream: (request: Parameters<LanguageModel["stream"]>[0]) =>
        model.stream({
          ...request,
          maxOutputTokens: Math.min(request.maxOutputTokens ?? maxOutputTokens, maxOutputTokens),
        }),
    }),
  }
}

/** Input-only limits are a conservative window: leave the same reserve without inventing a total. */
export function resolveAgentContextBudget(
  selection: AgentModelSelection,
  definition: LanguageModelDefinition = selection.model.definition
): AgentContextBudget {
  const modelWindow = definition.contextWindow ?? definition.maxInputTokens
  const windowTokens = modelWindow ?? DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS
  const reserveTokens = Math.max(
    Math.min(16_384, Math.floor(windowTokens * 0.25)),
    typeof selection.reasoning === "object" ? selection.reasoning.budgetTokens + 1 : 0
  )
  assertPositiveSafeInteger(windowTokens, "windowTokens")
  assertPositiveSafeInteger(reserveTokens, "reserveTokens")
  if (reserveTokens >= windowTokens) {
    throw invalidBudget("reserveTokens must be less than the resolved context window.")
  }
  const inputBudgetTokens = Math.min(
    definition.maxInputTokens ?? Number.POSITIVE_INFINITY,
    windowTokens - reserveTokens
  )
  assertPositiveSafeInteger(inputBudgetTokens, "inputBudgetTokens")
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
    source: modelWindow === undefined ? "fallback" : "model",
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
