import { AgentDefinitionError } from "@sixb/core"
import {
  AGENT_TOKEN_RATE_SAMPLES,
  type AgentContextTokenRateSample,
  agentContextSizeTokens,
  calibrateAgentContextBytesPerToken,
  learnedAgentContextBytesPerToken,
  measureAgentContextTokenRate,
  measureAgentModelRequest,
} from "@sixb/core/internal/agents"
import {
  defineLanguageModel,
  type LanguageModel,
  type LanguageModelDefinition,
  type LanguageModelRequest,
  type LanguageModelStreamEvent,
  type ModelReasoning,
} from "@sixb/core/models"

const DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS = 128_000

/** What compaction brings the context down to, as a share of the limit it crossed. */
export const AGENT_CONTEXT_COMPACTED_SHARE = 0.6

/** An idle thread this large compacts before its next call rewrites its cold cache whole. */
export const AGENT_IDLE_COMPACTION_TOKENS = 200_000

/**
 * The model's input limit: `inputBudgetTokens`, the window less the output reserve, which no call
 * crosses. Compaction starts past it.
 */
export interface AgentContextBudget {
  readonly windowTokens: number
  readonly inputBudgetTokens: number
  readonly reserveTokens: number
  /** The recent work compaction keeps verbatim. */
  readonly keepRecentTokens: number
  readonly source: "model" | "fallback"
  /**
   * UTF-8 bytes per token the run starts from, before a thread calibrates it: what the project's
   * runs measured on the model (see learnedAgentContextBytesPerToken).
   */
  readonly bytesPerToken: number
}

interface AgentModelSelection {
  readonly model: LanguageModel
  readonly reasoning?: ModelReasoning
  /**
   * What the project's runs measured of the model's tokenizer lately, newest first (see
   * readAgentContextTokenRates); none, and the run starts from the default, which errs high.
   */
  readonly tokenRates?: readonly AgentContextTokenRateSample[]
}

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
  const maxOutputTokens = outputCapTokens(selection.model, definition) ?? budget.reserveTokens
  if (
    typeof selection.reasoning === "object" &&
    selection.reasoning.budgetTokens >= maxOutputTokens
  ) {
    throw invalidBudget("output allowance must exceed the reasoning token budget.")
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
 */
function outputCeilingTokens(
  inputTokens: number,
  budget: AgentContextBudget,
  capTokens: number
): number {
  return Math.min(capTokens, Math.max(budget.reserveTokens, budget.windowTokens - inputTokens))
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
  const tokenRates = selection.tokenRates ?? []
  const bytesPerToken = learnedAgentContextBytesPerToken(tokenRates)
  if (!Number.isFinite(bytesPerToken) || bytesPerToken <= 0) {
    throw invalidBudget("token rates must measure a positive number of bytes per token.")
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
    source: modelWindow === undefined ? "fallback" : "model",
    bytesPerToken,
  })
}

/** The summary call's output allowance: half the output reserve, at most 8,192 tokens. */
export function contextSummaryOutputTokens(reserveTokens: number): number {
  return Math.min(8_192, Math.max(1, Math.floor(reserveTokens / 2)))
}

function invalidBudget(message: string): AgentDefinitionError {
  return new AgentDefinitionError(`[SixbAgent] Agent context ${message}`)
}

function assertPositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalidBudget(`${field} must be a positive safe integer.`)
  }
}
