import { AgentDefinitionError } from "@sixb/core"
import {
  AGENT_TOKEN_RATE_SAMPLES,
  type AgentContextBudget,
  type AgentContextTokenRateSample,
  type AgentModelSelection,
  agentContextSizeTokens,
  agentOutputCapTokens,
  calibrateAgentContextBytesPerToken,
  DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS,
  learnedAgentContextBytesPerToken,
  measureAgentContextTokenRate,
  measureAgentModelRequest,
  resolveAgentContextBudget,
} from "@sixb/core/internal/agents"
import {
  defineLanguageModel,
  type LanguageModel,
  type LanguageModelRequest,
  type LanguageModelStreamEvent,
} from "@sixb/core/models"

/**
 * Derive the model's input and output budgets from its definition, and cap each call's output to
 * them. The model comes pinned: whoever hands it over resolved it once for the run.
 */
export function prepareAgentModel(selection: AgentModelSelection): {
  readonly model: LanguageModel
  readonly budget: AgentContextBudget
  /**
   * The bytes per token the run's latest counted call measured, bounded around the run's rate (the
   * project's measurements and its own calls'), as calibration and the output ceiling read it.
   * Undefined until a call is counted.
   */
  readonly measuredBytesPerToken: () => number | undefined
} {
  const model = selection.model
  const definition = defineLanguageModel(model.definition)
  const budget = resolveAgentContextBudget(selection, definition)
  if (budget.source === "fallback") {
    console.warn(
      `[SixbAgent] No context limit is available for '${model.providerId}/${model.modelId}'; using the ${DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS.toLocaleString("en-US")}-token fallback.`
    )
  }
  const maxOutputTokens = agentOutputCapTokens(selection.model, definition) ?? budget.reserveTokens
  if (
    typeof selection.reasoning === "object" &&
    selection.reasoning.budgetTokens >= maxOutputTokens
  ) {
    throw new AgentDefinitionError(
      "[SixbAgent] Agent context output allowance must exceed the reasoning token budget."
    )
  }

  // The run's rate, from the project's measurements and, newest first, its own calls'.
  const tokenRates = selection.tokenRates ?? []
  const runTokenRates: AgentContextTokenRateSample[] = []
  let runBytesPerToken = budget.bytesPerToken
  // The rate the run's latest counted call measured, bounded around the run's; else the run's.
  let counted = false
  let measuredBytesPerToken = budget.bytesPerToken

  return {
    budget,
    measuredBytesPerToken: () => (counted ? measuredBytesPerToken : undefined),
    model: Object.freeze({
      providerId: model.providerId,
      modelId: model.modelId,
      definition: defineLanguageModel({ ...definition, maxOutputTokens }),
      costEstimator: model.costEstimator,
      ...(model.validateResponseFormat === undefined
        ? {}
        : { validateResponseFormat: model.validateResponseFormat.bind(model) }),
      stream: async (request: LanguageModelRequest) => {
        const size = measureAgentModelRequest(request)
        const stream = await model.stream({
          ...request,
          maxOutputTokens: Math.min(
            request.maxOutputTokens ?? maxOutputTokens,
            outputCeilingTokens(
              agentContextSizeTokens(size, Math.min(runBytesPerToken, measuredBytesPerToken)),
              budget,
              maxOutputTokens
            )
          ),
        })

        return {
          events: withCountedInput(stream.events, (inputTokens) => {
            const sample = measureAgentContextTokenRate({ size, inputTokens })
            if (sample) {
              // The newest 20 are all the statistic reads.
              runTokenRates.unshift(sample)
              runTokenRates.splice(AGENT_TOKEN_RATE_SAMPLES)
              runBytesPerToken = learnedAgentContextBytesPerToken([...runTokenRates, ...tokenRates])
            }

            measuredBytesPerToken = calibrateAgentContextBytesPerToken({
              bytesPerToken: runBytesPerToken,
              size,
              inputTokens,
            })
            counted = true
          }),
        }
      },
    }),
  }
}

/**
 * A call may write whatever its input leaves of the window, up to the cap, and the reserve at
 * least. The input is weighed at the denser of the run's rate and the one its latest call
 * measured, so it errs high whichever way this request's content tokenizes: a call right after a
 * large tool result can read denser than the calls it was calibrated on, and with no turn to ask
 * it again, an allowance past the window's room is a refused call.
 *
 * Below the reserve, only the guard decides (see createAgentContextGuard): it weighs the request
 * from what the provider counted, and caps the request it lets past the limit at its own room.
 */
function outputCeilingTokens(
  inputTokens: number,
  budget: AgentContextBudget,
  capTokens: number
): number {
  return Math.max(
    Math.min(capTokens, budget.reserveTokens),
    agentOutputRoomTokens(inputTokens, budget, capTokens)
  )
}

/**
 * What a call may write for what its input weighs: the room it leaves of the window, up to
 * `capTokens`. The one measure the output ceiling and the guard size a call's answer by.
 */
export function agentOutputRoomTokens(
  inputTokens: number,
  budget: AgentContextBudget,
  capTokens: number
): number {
  return Math.min(capTokens, budget.windowTokens - inputTokens)
}

/**
 * The least room a request past its model's limit is still sent with: what a compaction summary
 * may write (see contextSummaryOutputTokens), the answer the framework already sizes as enough to
 * carry a conversation on. With less, the turn ends with the context error rather than send a
 * call whose answer would be cut off almost at once.
 */
export function agentMinimumAnswerTokens(budget: AgentContextBudget): number {
  return contextSummaryOutputTokens(budget.reserveTokens)
}

/**
 * A call's request as the conversation estimator weighs it (see measureAgentModelRequest), at
 * `bytesPerToken`.
 */
export function estimateAgentRequestTokens(
  request: Pick<LanguageModelRequest, "messages" | "tools" | "responseFormat">,
  bytesPerToken: number
): number {
  return agentContextSizeTokens(measureAgentModelRequest(request), bytesPerToken)
}

/** The events as they come, handing over the input tokens the provider counted once it says. */
async function* withCountedInput(
  events: AsyncIterable<LanguageModelStreamEvent>,
  counted: (inputTokens: number) => void
): AsyncIterable<LanguageModelStreamEvent> {
  for await (const event of events) {
    const inputTokens = event.type === "finish" ? event.usage.inputTokens : undefined
    if (inputTokens !== undefined && inputTokens > 0) counted(inputTokens)

    yield event
  }
}
