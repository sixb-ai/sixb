import type { LanguageModelV4 } from "@ai-sdk/provider"
import { defineAgent } from "./builders"
import type { AgentDefinition, AgentToolDefinition } from "./types"

/** Stable internal identity for the framework-owned conversational agent. */
export const MAIN_AGENT_ID = "main"

/** User-facing name for the project's single conversational entry point. */
export const MAIN_AGENT_NAME = "Sixb"

/** The project supplies capabilities; Sixb owns the main agent's baseline role. */
export const MAIN_AGENT_INSTRUCTIONS =
  "Help the user complete their request using the capabilities available in this project."

/** Public capability reference used by security grants such as `can.run(agent)`. */
export interface AgentReference {
  readonly kind: "agent"
  readonly id: typeof MAIN_AGENT_ID
}

export const agent: AgentReference = Object.freeze({
  kind: "agent",
  id: MAIN_AGENT_ID,
})

/** Transitional adapter for the AgentDefinition-based conversation engine. */
export function createMainAgentDefinition(input: {
  readonly model: LanguageModelV4
  readonly tools: readonly AgentToolDefinition[]
}): AgentDefinition<typeof MAIN_AGENT_ID> {
  return defineAgent(MAIN_AGENT_ID, {
    name: MAIN_AGENT_NAME,
    model: input.model,
    instructions: MAIN_AGENT_INSTRUCTIONS,
    tools: input.tools,
  })
}
