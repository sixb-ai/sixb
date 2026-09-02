import {
  cloneJsonValue,
  getInvalidJsonValueReason,
  type JsonValue,
  type ReadonlyJsonValue,
} from "../json"
import { AgentDefinitionError, AgentToolResultValidationError } from "./errors"
import { getInvalidAgentToolResultReason } from "./tool-result"
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
  assertValidProjectAgentToolDefinitions,
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
      let snapshot: JsonValue
      try {
        // AgentToolResult is intentionally expressed with FileRef instead of a duplicate JSON-only
        // shape. Runtime validation below proves that the complete envelope crosses the same JSON
        // boundary as legacy results.
        snapshot = cloneJsonValue(result as ReadonlyJsonValue, "result")
      } catch (cause) {
        throw new AgentToolResultValidationError(
          definition.name,
          getInvalidJsonValueReason(result, "result") ?? "result could not be cloned safely",
          { cause }
        )
      }
      const richResultReason = getInvalidAgentToolResultReason(snapshot)
      if (richResultReason) {
        throw new AgentToolResultValidationError(definition.name, richResultReason)
      }
      return snapshot
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

  return normalizeAgentToolDefinitions(tools)
}

export function toolsFromProjectConfig(
  tools: readonly AgentToolDefinition[] | undefined
): readonly AgentToolDefinition[] {
  if (tools === undefined) {
    return EMPTY_AGENT_TOOLS
  }
  if (!Array.isArray(tools)) {
    throw new AgentDefinitionError(
      "[Sixb] Project tools must be an array of agent tool definitions."
    )
  }

  assertValidProjectAgentToolDefinitions(tools)
  return normalizeAgentToolDefinitions(tools)
}

function normalizeAgentToolDefinitions(
  tools: readonly AgentToolDefinition[]
): readonly AgentToolDefinition[] {
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
