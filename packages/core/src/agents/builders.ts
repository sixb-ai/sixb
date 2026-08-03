import { assertJsonValue } from "../json"
import { AgentDefinitionError } from "./errors"
import type {
  AgentDefinition,
  AgentToolDescriptionBuilder,
  AgentToolHandler,
  AgentToolInputSchema,
  DefineAgentConfig,
} from "./types"
import {
  assertNonEmpty,
  assertValidAgentToolDescription,
  assertValidAgentToolInput,
  assertValidAgentToolName,
  assertValidLoopConfig,
  assertValidProviderOptions,
  assertValidReasoningLevel,
  groupIdsFromDefinitions,
  toolsFromDefinitions,
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

  const builder = {
    description(description: string) {
      assertValidAgentToolDescription(name, description)

      return {
        input(input: AgentToolInputSchema) {
          assertValidAgentToolInput(name, input)

          return {
            run(handler: AgentToolHandler<Record<string, unknown>>) {
              if (typeof handler !== "function") {
                throw new AgentDefinitionError(
                  `[Sixb] Agent tool '${name}' handler must be a function.`
                )
              }

              return {
                kind: "agentTool",
                name,
                description,
                input,
                handler: async (context: Parameters<typeof handler>[0]) => {
                  const result = await handler(context)
                  assertJsonValue(result, `Agent tool '${name}' result`)
                  return result
                },
              }
            },
          }
        },
      }
    },
  }
  return builder as unknown as AgentToolDescriptionBuilder<TName>
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
  assertValidLoopConfig(config.loop)
  const groupIds = groupIdsFromDefinitions(id, config.groups)
  const tools = toolsFromDefinitions(id, config.tools)

  return {
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
    ...(config.loop !== undefined ? { loop: config.loop } : {}),
  }
}
