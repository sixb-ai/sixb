import { defineAgent } from "./builders"
import type { AgentDefinition, DefineAgentConfig } from "./types"

/**
 * Id of the framework-managed main agent.
 *
 * Reserved: a project agent may not claim it while `createSixb({ mainAgent })` is configured.
 */
export const MAIN_AGENT_ID = "main"

/**
 * Declarative config accepted by `createSixb({ mainAgent })`.
 *
 * A `Pick` of {@link DefineAgentConfig} rather than a standalone interface so the two cannot drift.
 * `tools` and `groups` are deliberately absent: the main agent receives the injected `sub_agent`
 * tool and nothing else, and it reaches other agents through the requester's grants rather than
 * its own. See `docs/agents/main-agent.md`.
 */
export type MainAgentConfig = Pick<
  DefineAgentConfig,
  "name" | "description" | "model" | "reasoning" | "providerOptions" | "instructions" | "loop"
>

/**
 * Build the framework-owned main agent definition.
 *
 * Delegates to {@link defineAgent} so the injected definition is validated and frozen by exactly
 * the same code path as an authored one.
 */
export function createMainAgentDefinition(
  config: MainAgentConfig
): AgentDefinition<typeof MAIN_AGENT_ID> {
  return defineAgent(MAIN_AGENT_ID, { ...config, groups: [], tools: [] })
}
