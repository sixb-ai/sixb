import type { LanguageModel, LanguageModelDefinition, ModelReasoning } from "../models"
import {
  type AgentContextTokenRateSample,
  learnedAgentContextBytesPerToken,
} from "./context-token-rate"
import { AgentDefinitionError } from "./errors"

/**
 * A model's context limit. The worker sizes each call with it, and the API answers what a
 * thread's meter shows from the same functions.
 */

export const DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS = 128_000

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

export interface AgentModelSelection {
  readonly model: LanguageModel
  readonly reasoning?: ModelReasoning
  /**
   * What the project's runs measured of the model's tokenizer lately, newest first (see
   * readAgentContextTokenRates); none, and the run starts from the default, which errs high.
   */
  readonly tokenRates?: readonly AgentContextTokenRateSample[]
}

/** The most one call may write: the binding's limit, capped at the model maximum. */
export function agentOutputCapTokens(
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
      agentOutputCapTokens(selection.model, definition) ?? Number.POSITIVE_INFINITY
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
