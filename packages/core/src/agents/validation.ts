import { getInvalidJsonValueReason, isPlainRecord } from "../json"
import type { GroupDefinition, SecurityRegistry } from "../security"
import { AgentDefinitionError } from "./errors"
import {
  AGENT_REASONING_LEVELS,
  type AgentDefinition,
  type AgentLoopConfig,
  type AgentReasoningLevel,
  type AgentToolDefinition,
  type DefineAgentConfig,
} from "./types"

const AGENT_TOOL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/
const AGENT_TOOL_PRIMITIVE_SCHEMAS = new Set([
  "string",
  "integer",
  "double",
  "decimal",
  "boolean",
  "date",
  "timestamp",
  "uuid",
  "fileRef",
])

export const AGENT_RESERVED_TOOL_NAMES = ["bash"] as const

export function assertNonEmpty(value: string, field: string): void {
  if (!value.trim()) {
    throw new AgentDefinitionError(`[Sixb] Agent ${field} must not be empty.`)
  }
}

export function isAgentDefinition(value: unknown): value is AgentDefinition {
  return (
    isRecord(value) &&
    value.kind === "agent" &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.instructions === "string" &&
    (value.reasoning === undefined || isAgentReasoningLevel(value.reasoning)) &&
    (value.providerOptions === undefined || isProviderOptions(value.providerOptions)) &&
    Array.isArray(value.groupIds) &&
    Array.isArray(value.tools) &&
    value.tools.every(isAgentToolDefinition)
  )
}

export function isAgentToolDefinition(value: unknown): value is AgentToolDefinition {
  return (
    isRecord(value) &&
    value.kind === "agentTool" &&
    typeof value.name === "string" &&
    typeof value.description === "string" &&
    isPlainRecord(value.input) &&
    typeof value.handler === "function"
  )
}

export function assertValidAgentToolName(name: unknown): asserts name is string {
  if (typeof name !== "string" || !AGENT_TOOL_NAME_PATTERN.test(name)) {
    throw new AgentDefinitionError(
      "[Sixb] Agent tool name must be 1-64 characters, start with a letter or underscore, and contain only letters, numbers, underscores, or hyphens."
    )
  }
  if ((AGENT_RESERVED_TOOL_NAMES as readonly string[]).includes(name)) {
    throw new AgentDefinitionError(`[Sixb] Agent tool name '${name}' is reserved by the framework.`)
  }
}

export function assertValidAgentToolDescription(name: string, description: unknown): void {
  if (typeof description !== "string" || !description.trim()) {
    throw new AgentDefinitionError(`[Sixb] Agent tool '${name}' description must not be empty.`)
  }
}

export function assertValidAgentToolInput(name: string, input: unknown): void {
  if (!isPlainRecord(input)) {
    throw new AgentDefinitionError(`[Sixb] Agent tool '${name}' input must be a schema object.`)
  }

  for (const [field, schema] of Object.entries(input)) {
    if (!field.trim()) {
      throw new AgentDefinitionError(
        `[Sixb] Agent tool '${name}' input field names must not be empty.`
      )
    }
    assertValidAgentToolSchema(name, schema, `input.${field}`, new Set())
  }
}

export function toolsFromDefinitions(
  agentId: string,
  tools: readonly AgentToolDefinition[] | undefined
): readonly AgentToolDefinition[] {
  if (tools === undefined) {
    return []
  }
  if (!Array.isArray(tools)) {
    throw new AgentDefinitionError(
      `[Sixb] Agent '${agentId}' tools must be an array of agent tool definitions.`
    )
  }

  const seen = new Set<string>()
  return tools.map((tool) => {
    if (!isAgentToolDefinition(tool)) {
      throw new AgentDefinitionError(
        `[Sixb] Agent '${agentId}' tools must contain only agent tool definitions.`
      )
    }

    assertValidAgentToolName(tool.name)
    assertValidAgentToolDescription(tool.name, tool.description)
    assertValidAgentToolInput(tool.name, tool.input)
    if (seen.has(tool.name)) {
      throw new AgentDefinitionError(
        `[Sixb] Agent '${agentId}' tools contains duplicate tool name '${tool.name}'.`
      )
    }
    seen.add(tool.name)
    return tool
  })
}

export function assertValidLoopConfig(loop: AgentLoopConfig | undefined): void {
  const maxSteps = loop?.stopWhen?.maxSteps
  if (maxSteps === undefined) {
    return
  }
  if (!Number.isInteger(maxSteps) || maxSteps <= 0) {
    throw new AgentDefinitionError(
      "[Sixb] Agent loop.stopWhen.maxSteps must be a positive finite integer."
    )
  }
}

export function assertValidReasoningLevel(reasoning: AgentReasoningLevel | undefined): void {
  if (reasoning === undefined) {
    return
  }
  if (!isAgentReasoningLevel(reasoning)) {
    throw new AgentDefinitionError(
      `[Sixb] Agent reasoning must be one of: ${AGENT_REASONING_LEVELS.join(", ")}.`
    )
  }
}

export function assertValidProviderOptions(
  providerOptions: DefineAgentConfig["providerOptions"]
): void {
  if (providerOptions === undefined) {
    return
  }

  const reason = getInvalidJsonValueReason(providerOptions, "providerOptions")
  if (!isRecord(providerOptions) || reason) {
    throw new AgentDefinitionError(
      `[Sixb] Agent providerOptions must be a provider-keyed JSON object${reason ? `; ${reason}` : "."}`
    )
  }

  for (const [provider, options] of Object.entries(providerOptions)) {
    if (!provider.trim()) {
      throw new AgentDefinitionError(
        "[Sixb] Agent providerOptions provider names must not be empty."
      )
    }
    const optionsReason = getInvalidJsonValueReason(options, `providerOptions.${provider}`)
    if (!isRecord(options) || optionsReason) {
      throw new AgentDefinitionError(
        `[Sixb] Agent providerOptions.${provider} must be a JSON object${optionsReason ? `; ${optionsReason}` : "."}`
      )
    }
  }
}

export function groupIdsFromDefinitions(
  agentId: string,
  groups: readonly GroupDefinition[] | undefined
): readonly string[] {
  const groupIds = (groups ?? []).map((group) => {
    if (!isRecord(group) || group.kind !== "group") {
      throw new AgentDefinitionError(
        `[Sixb] Agent '${agentId}' groups must contain only group definitions.`
      )
    }

    assertNonEmpty(group.id, `Agent '${agentId}' group id`)
    return group.id
  })

  assertNoDuplicateGroupIds(agentId, groupIds)
  return groupIds
}

export function validateAgentGroupReferences(
  agents: readonly AgentDefinition[],
  security: SecurityRegistry
): void {
  for (const agent of agents) {
    assertNoDuplicateGroupIds(agent.id, agent.groupIds)
    for (const groupId of agent.groupIds) {
      if (!security.getGroupById(groupId)) {
        throw new AgentDefinitionError(
          `[Sixb] Agent '${agent.id}' groups references unknown group '${groupId}'. Add it to 'security/groups/' or pass it to createSixb({ groups }).`
        )
      }
    }
  }
}

function assertNoDuplicateGroupIds(agentId: string, groupIds: readonly string[]): void {
  const seen = new Set<string>()
  for (const groupId of groupIds) {
    assertNonEmpty(groupId, `Agent '${agentId}' group id`)
    if (seen.has(groupId)) {
      throw new AgentDefinitionError(
        `[Sixb] Agent '${agentId}' groups contains duplicate group id '${groupId}'.`
      )
    }
    seen.add(groupId)
  }
}

function isAgentReasoningLevel(value: unknown): value is AgentReasoningLevel {
  return typeof value === "string" && (AGENT_REASONING_LEVELS as readonly string[]).includes(value)
}

function isProviderOptions(
  value: unknown
): value is NonNullable<DefineAgentConfig["providerOptions"]> {
  if (!isRecord(value) || getInvalidJsonValueReason(value) !== undefined) {
    return false
  }
  return Object.entries(value).every(
    ([provider, options]) =>
      provider.trim().length > 0 &&
      isRecord(options) &&
      getInvalidJsonValueReason(options) === undefined
  )
}

function assertValidAgentToolSchema(
  toolName: string,
  schema: unknown,
  path: string,
  visiting: Set<object>
): void {
  if (typeof schema === "string") {
    if (AGENT_TOOL_PRIMITIVE_SCHEMAS.has(schema)) {
      return
    }
    throw invalidAgentToolSchema(toolName, path)
  }
  if (!isPlainRecord(schema) || typeof schema.type !== "string" || visiting.has(schema)) {
    throw invalidAgentToolSchema(toolName, path)
  }

  visiting.add(schema)
  switch (schema.type) {
    case "enum": {
      const values = schema.values
      const validValues =
        Array.isArray(values) &&
        values.length > 0 &&
        (schema.valueType === "string"
          ? values.every((value) => typeof value === "string")
          : schema.valueType === "integer" &&
            values.every((value) => typeof value === "number" && Number.isInteger(value)))
      if (!validValues || new Set(values).size !== values.length) {
        throw invalidAgentToolSchema(toolName, path)
      }
      break
    }
    case "array":
      assertValidAgentToolSchema(toolName, schema.items, `${path}.items`, visiting)
      break
    case "map":
      if (schema.keySchema !== "string") {
        throw invalidAgentToolSchema(toolName, path)
      }
      assertValidAgentToolSchema(toolName, schema.valueSchema, `${path}.valueSchema`, visiting)
      break
    case "object": {
      if (!isPlainRecord(schema.properties)) {
        throw invalidAgentToolSchema(toolName, path)
      }
      for (const [fieldId, field] of Object.entries(schema.properties)) {
        if (!fieldId.trim() || !isPlainRecord(field) || !("schema" in field)) {
          throw invalidAgentToolSchema(toolName, `${path}.properties.${fieldId}`)
        }
        if (
          (field.required !== undefined && typeof field.required !== "boolean") ||
          (field.nullable !== undefined && typeof field.nullable !== "boolean") ||
          (field.description !== undefined &&
            (typeof field.description !== "string" || !field.description.trim()))
        ) {
          throw invalidAgentToolSchema(toolName, `${path}.properties.${fieldId}`)
        }
        assertValidAgentToolSchema(
          toolName,
          field.schema,
          `${path}.properties.${fieldId}.schema`,
          visiting
        )
      }
      break
    }
    case "valueTypeRef":
      if (typeof schema.valueTypeId !== "string" || !schema.valueTypeId.trim()) {
        throw invalidAgentToolSchema(toolName, path)
      }
      if (schema._resolved !== undefined) {
        assertValidAgentToolSchema(toolName, schema._resolved, `${path}._resolved`, visiting)
      }
      break
    default:
      throw invalidAgentToolSchema(toolName, path)
  }
  visiting.delete(schema)
}

function invalidAgentToolSchema(toolName: string, path: string): AgentDefinitionError {
  return new AgentDefinitionError(
    `[Sixb] Agent tool '${toolName}' ${path} must be a valid Sixb schema.`
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
