import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider"
import type { GroupDefinition } from "../security"

export type AgentReasoningLevel = NonNullable<LanguageModelV4CallOptions["reasoning"]>

export const AGENT_REASONING_LEVELS = [
  "provider-default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const satisfies readonly AgentReasoningLevel[]

/**
 * Loop / stop controls for an agent run.
 *
 * Consumed by the agent worker when it executes a run.
 */
export interface AgentLoopConfig {
  readonly stopWhen?: {
    readonly maxSteps?: number
  }
}

/**
 * Declarative config accepted by {@link defineAgent}.
 *
 * Every field is a static value. `instructions` is a plain string; widening it to
 * `string | (ctx) => string` later would be backwards-compatible.
 */
export interface DefineAgentConfig {
  readonly name: string
  readonly description?: string
  readonly model: LanguageModelV4
  readonly reasoning?: AgentReasoningLevel
  readonly providerOptions?: LanguageModelV4CallOptions["providerOptions"]
  readonly instructions: string
  readonly groups?: readonly GroupDefinition[]
  readonly loop?: AgentLoopConfig
}

/**
 * Agent definition registered with Sixb.
 *
 * Definitions are safe to export from `agents/` modules; the runtime loads and
 * registers them. The agent worker runs them as streaming turns. The `model` is an
 * AI SDK language model instance and is therefore not serialisable — the worker
 * resolves a definition from its own discovery rather than over the wire.
 */
export interface AgentDefinition<TId extends string = string> {
  readonly kind: "agent"
  readonly id: TId
  readonly name: string
  readonly description?: string
  readonly model: LanguageModelV4
  readonly reasoning?: AgentReasoningLevel
  readonly providerOptions?: LanguageModelV4CallOptions["providerOptions"]
  readonly instructions: string
  readonly groupIds: readonly string[]
  readonly loop?: AgentLoopConfig
}
