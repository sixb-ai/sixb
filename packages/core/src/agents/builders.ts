import { AgentDefinitionError } from "./errors"
import type { AgentDefinition, DefineAgentConfig } from "./types"
import { assertNonEmpty, assertValidLoopConfig } from "./validation"

/**
 * Define an agent: a conversational, looping actor auto-discovered from `agents/`.
 *
 * The returned definition is inert and can be exported from a project-level `agents/`
 * module. Later slices turn it into a running, streaming agent; PR1 only loads and
 * registers it (`sixb.agents`).
 */
export function defineAgent<const TId extends string>(
  id: TId,
  config: DefineAgentConfig
): AgentDefinition<TId> {
  assertNonEmpty(id, "id")
  assertNonEmpty(config.name, "name")
  assertNonEmpty(config.instructions, "instructions")

  if (config.model === undefined || config.model === null) {
    throw new AgentDefinitionError("[Sixb] Agent model is required.")
  }
  assertValidLoopConfig(config.loop)

  return {
    kind: "agent",
    id,
    name: config.name,
    model: config.model,
    instructions: config.instructions,
    ...(config.description !== undefined ? { description: config.description } : {}),
    ...(config.loop !== undefined ? { loop: config.loop } : {}),
  }
}
