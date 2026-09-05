import { createAgentToolDefinition } from "./tool-definition"
import type {
  AgentToolDefinition,
  AgentToolDescriptionBuilder,
  AgentToolHandler,
  AgentToolInputBuilder,
  AgentToolInputSchema,
  AgentToolRunBuilder,
  InferAgentToolInputSchema,
} from "./types"
import {
  assertValidAgentToolDescription,
  assertValidAgentToolInput,
  assertValidAgentToolName,
} from "./validation"

/**
 * Define a reusable tool registered through `createSixb({ tools })`.
 *
 * The returned definition is inert. The agent worker supplies its run-scoped
 * context and executes the handler only when a run calls the tool.
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
