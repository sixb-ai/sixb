import type { LanguageModelV3 } from "@ai-sdk/provider"

/**
 * Loop / stop controls for an agent run.
 *
 * Inert in PR1 — consumed by the agent worker in a later slice.
 */
export interface AgentLoopConfig {
  readonly stopWhen?: {
    readonly maxSteps?: number
  }
}

/**
 * Declarative config accepted by {@link defineAgent}.
 *
 * Every field is a static value in PR1. `instructions` is a plain string for now;
 * widening it to `string | (ctx) => string` later is backwards-compatible.
 */
export interface DefineAgentConfig {
  readonly name: string
  readonly description?: string
  readonly model: LanguageModelV3
  readonly instructions: string
  readonly loop?: AgentLoopConfig
}

/**
 * Inert agent definition registered with Sixb.
 *
 * Definitions are safe to export from `agents/` modules. Later slices turn them into
 * running, streaming agents; PR1 only loads and registers them. The `model` is an
 * AI SDK v6 `LanguageModelV3` instance and is therefore not serialisable — the worker
 * (later slice) resolves a definition from its own discovery rather than over the wire.
 */
export interface AgentDefinition<TId extends string = string> {
  readonly kind: "agent"
  readonly id: TId
  readonly name: string
  readonly description?: string
  readonly model: LanguageModelV3
  readonly instructions: string
  readonly loop?: AgentLoopConfig
}
