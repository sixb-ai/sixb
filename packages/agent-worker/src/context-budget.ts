import { AgentDefinitionError } from "@sixb/core"
import { resolveLanguageModel } from "@sixb/core/internal/model-execution"
import {
  defineLanguageModel,
  type LanguageModel,
  type LanguageModelDefinition,
  type LanguageModelRequest,
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
  const budget = resolveAgentContextBudget(selection, definition)
  if (budget.source === "fallback") {
    console.warn(
      `[SixbAgentWorker] No context limit is available for '${model.providerId}/${model.modelId}'; using the ${DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS.toLocaleString("en-US")}-token fallback.`
    )
  }
  const maxOutputTokens = outputCapTokens(selection.model, definition) ?? budget.reserveTokens
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
      ...(model.validateResponseFormat === undefined
        ? {}
        : { validateResponseFormat: model.validateResponseFormat.bind(model) }),
      stream: (request: LanguageModelRequest) =>
        model.stream({
          ...request,
          maxOutputTokens: Math.min(
            request.maxOutputTokens ?? maxOutputTokens,
            outputCeilingTokens(request, budget, maxOutputTokens)
          ),
        }),
    }),
  }
}

/**
 * A call may write whatever its input leaves of the window, up to the cap. Compaction keeps the
 * input within its budget, so the reserve is always left, and it is all a call gets when its input
 * cannot be estimated.
 */
function outputCeilingTokens(
  request: LanguageModelRequest,
  budget: AgentContextBudget,
  capTokens: number
): number {
  const inputTokens = estimateRequestInputTokens(request)
  if (inputTokens === undefined) return budget.reserveTokens
  return Math.min(capTokens, Math.max(budget.reserveTokens, budget.windowTokens - inputTokens))
}

/**
 * Serialized bytes at two per token. Gateway tokenizers measured from 2.8 (Hindi on GLM) to 12
 * bytes per token, and an underestimate is the costly side: whenever the window bounds the ceiling,
 * any input it misses overflows providers that reject input plus output beyond the window. Attached
 * files have no byte-to-token rate.
 */
function estimateRequestInputTokens(request: LanguageModelRequest): number | undefined {
  const hasFile = request.messages.some(
    (message) => message.role === "user" && message.content.some((part) => part.type === "file")
  )
  if (hasFile) return undefined
  const serialized = JSON.stringify([request.messages, request.tools, request.responseFormat])
  return Math.ceil(new TextEncoder().encode(serialized).byteLength / 2)
}

/** The most one call may write: the binding's limit, capped at the model maximum. */
function outputCapTokens(
  binding: LanguageModel,
  definition: LanguageModelDefinition
): number | undefined {
  if (binding.maxOutputTokens === undefined) return definition.maxOutputTokens
  return Math.min(binding.maxOutputTokens, definition.maxOutputTokens ?? binding.maxOutputTokens)
}

/**
 * Input-only limits are a conservative window: leave the same reserve without inventing a total.
 * The reserve is the output every call is guaranteed, not its ceiling, so it stays small and a
 * larger output limit never shrinks the input budget.
 */
export function resolveAgentContextBudget(
  selection: AgentModelSelection,
  definition: LanguageModelDefinition = selection.model.definition
): AgentContextBudget {
  const modelWindow = definition.contextWindow ?? definition.maxInputTokens
  const windowTokens = modelWindow ?? DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS
  const reserveTokens = Math.max(
    Math.min(
      16_384,
      Math.floor(windowTokens * 0.25),
      outputCapTokens(selection.model, definition) ?? Number.POSITIVE_INFINITY
    ),
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
