import { cloneJsonValue, getInvalidJsonValueReason } from "../json"
import { AgentDefinitionError, AgentToolResultValidationError } from "./errors"
import type {
  AgentToolDefinition,
  AgentToolHandler,
  AgentToolInputSchema,
  InferAgentToolInputSchema,
} from "./types"
import {
  assertValidAgentToolDefinitions,
  assertValidAgentToolDescription,
  assertValidAgentToolName,
  validateAndSnapshotAgentToolInput,
} from "./validation"

const EMPTY_AGENT_TOOLS: readonly AgentToolDefinition[] = Object.freeze([])
const normalizedAgentTools = new WeakSet<AgentToolDefinition>()

export function createAgentToolDefinition<
  const TName extends string,
  const TInput extends AgentToolInputSchema,
>(definition: {
  readonly name: TName
  readonly description: string
  readonly input: TInput
  readonly handler: AgentToolHandler<InferAgentToolInputSchema<TInput>>
}): AgentToolDefinition<TName, TInput> {
  assertValidAgentToolName(definition.name)
  assertValidAgentToolDescription(definition.name, definition.description)
  if (typeof definition.handler !== "function") {
    throw new AgentDefinitionError(
      `[Sixb] Agent tool '${definition.name}' handler must be a function.`
    )
  }

  const input = validateAndSnapshotAgentToolInput(definition.name, definition.input)
  const tool: AgentToolDefinition<TName, TInput> = {
    kind: "agentTool",
    name: definition.name,
    description: definition.description,
    input,
    handler: async (context) => {
      const result = await definition.handler(context)
      try {
        return cloneJsonValue(result, "result")
      } catch (cause) {
        throw new AgentToolResultValidationError(
          definition.name,
          getInvalidJsonValueReason(result, "result") ?? "result could not be cloned safely",
          { cause }
        )
      }
    },
  }

  normalizedAgentTools.add(tool)
  return Object.freeze(tool)
}

export function toolsFromDefinitions(
  agentId: string,
  tools: readonly AgentToolDefinition[] | undefined
): readonly AgentToolDefinition[] {
  if (tools === undefined) {
    return EMPTY_AGENT_TOOLS
  }
  if (!Array.isArray(tools)) {
    throw new AgentDefinitionError(
      `[Sixb] Agent '${agentId}' tools must be an array of agent tool definitions.`
    )
  }

  assertValidAgentToolDefinitions(agentId, tools)

  const normalized: AgentToolDefinition[] = []
  for (const tool of tools) {
    normalized.push(normalizeAgentToolDefinition(tool))
  }
  return Object.freeze(normalized)
}

function normalizeAgentToolDefinition(tool: AgentToolDefinition): AgentToolDefinition {
  if (normalizedAgentTools.has(tool)) {
    return tool
  }

  return createAgentToolDefinition({
    name: tool.name,
    description: tool.description,
    input: tool.input,
    handler: (context) => tool.handler(context),
  })
}
