import { AgentDefinitionError } from "./errors"
import type { AgentDefinition, DefineAgentConfig } from "./types"
import {
  assertNonEmpty,
  assertValidLoopConfig,
  assertValidProviderOptions,
  assertValidReasoningLevel,
  groupIdsFromDefinitions,
} from "./validation"

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
  assertValidReasoningLevel(config.reasoning)
  assertValidProviderOptions(config.providerOptions)
  assertValidLoopConfig(config.loop)
  const groupIds = groupIdsFromDefinitions(id, config.groups)

  return {
    kind: "agent",
    id,
    name: config.name,
    model: config.model,
    ...(config.reasoning !== undefined ? { reasoning: config.reasoning } : {}),
    ...(config.providerOptions !== undefined ? { providerOptions: config.providerOptions } : {}),
    instructions: config.instructions,
    groupIds,
    ...(config.description !== undefined ? { description: config.description } : {}),
    ...(config.loop !== undefined ? { loop: config.loop } : {}),
  }
}
