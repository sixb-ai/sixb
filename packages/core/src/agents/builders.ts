import { AgentDefinitionError } from "./errors"
import { createAgentToolDefinition, toolsFromDefinitions } from "./tool-definition"
import type {
  AgentDefinition,
  AgentToolDefinition,
  AgentToolDescriptionBuilder,
  AgentToolHandler,
  AgentToolInputBuilder,
  AgentToolInputSchema,
  AgentToolRunBuilder,
  DefineAgentConfig,
  InferAgentToolInputSchema,
} from "./types"
import {
  assertNonEmpty,
  assertValidAgentToolDescription,
  assertValidAgentToolInput,
  assertValidAgentToolName,
  assertValidProviderOptions,
  assertValidReasoningLevel,
  groupIdsFromDefinitions,
  resolveAgentLoopConfig,
} from "./validation"

/**
 * Define a reusable tool that can be selected explicitly by one or more agents.
 *
 * The returned definition is inert. The agent worker supplies its run-scoped
 * context and executes the handler only when a selected agent calls the tool.
 */
export function defineAgentTool<const TName extends string>(
  name: TName
): AgentToolDescriptionBuilder<TName> {
  assertValidAgentToolName(name)

  return {
    description(description: string): AgentToolInputBuilder<TName> {
      assertValidAgentToolDescription(name, description)

      return {
        input<const TInput extends AgentToolInputSchema>(
          input: TInput
        ): AgentToolRunBuilder<TName, TInput> {
          assertValidAgentToolInput(name, input)

          return {
            run(
              handler: AgentToolHandler<InferAgentToolInputSchema<TInput>>
            ): AgentToolDefinition<TName, TInput> {
              return createAgentToolDefinition({ name, description, input, handler })
            },
          }
        },
      }
    },
  }
}

/**
 * Define an agent: a conversational, looping actor auto-discovered from `agents/`.
 *
 * The returned definition is declarative and can be exported from a project-level
 * `agents/` module. The runtime loads and registers it (`sixb.agents`); the agent
 * worker executes it as a running, streaming agent.
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
  const loop = resolveAgentLoopConfig(config.loop)
  const groupIds = groupIdsFromDefinitions(id, config.groups)
  const tools = toolsFromDefinitions(id, config.tools)

  return Object.freeze({
    kind: "agent",
    id,
    name: config.name,
    model: config.model,
    ...(config.reasoning !== undefined ? { reasoning: config.reasoning } : {}),
    ...(config.providerOptions !== undefined ? { providerOptions: config.providerOptions } : {}),
    instructions: config.instructions,
    groupIds,
    tools,
    ...(config.description !== undefined ? { description: config.description } : {}),
    ...(loop !== undefined ? { loop } : {}),
  })
}
