import { getInvalidJsonValueReason, isPlainRecord, type JsonValue } from "../json"
import { isModelReasoning } from "../models"
import {
  normalizeSchemaValue,
  type ObjectSchema,
  OntologyValidationError,
  type ValueType,
  validateSchemaValue,
} from "../ontology"
import type { GroupDefinition, SecurityDefinitionCatalog } from "../security"
import { AgentDefinitionError } from "./errors"
import {
  AGENT_REASONING_LEVELS,
  type AgentDefinition,
  type AgentLoopConfig,
  type AgentReasoning,
  type AgentToolDefinition,
  type AgentToolInputSchema,
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

export const AGENT_RESERVED_TOOL_NAMES = ["bash", "read", "view_file"] as const

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
    (value.reasoning === undefined || isModelReasoning(value.reasoning)) &&
    Array.isArray(value.groupIds) &&
    isAgentToolDefinitionArray(value.tools)
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

export function validateAndSnapshotAgentToolInput<TInput extends AgentToolInputSchema>(
  toolName: string,
  input: TInput
): TInput {
  assertValidAgentToolInput(toolName, input)
  try {
    return deepFreeze(structuredClone(input))
  } catch {
    throw new AgentDefinitionError(
      `[Sixb] Agent tool '${toolName}' input must be safely snapshot-compatible.`
    )
  }
}

/** Validate model input against a tool schema, normalize it to JSON, and lock the snapshot. */
export function validateAndNormalizeAgentToolInput(
  toolName: string,
  shape: AgentToolInputSchema,
  value: unknown,
  valueTypesById: ReadonlyMap<string, ValueType>
): Record<string, JsonValue> {
  const label = `Agent tool '${toolName}' input`
  if (!isPlainRecord(value)) {
    throw new OntologyValidationError(`[Sixb] ${label} must be a JSON object.`)
  }

  const reason = getInvalidJsonValueReason(value, label)
  if (reason) {
    throw new OntologyValidationError(`[Sixb] ${label} must be JSON-compatible; ${reason}.`)
  }

  const schema: ObjectSchema = {
    type: "object",
    properties: Object.fromEntries(
      Object.entries(shape).map(([field, fieldSchema]) => [
        field,
        { schema: fieldSchema, required: true },
      ])
    ),
  }
  validateSchemaValue(schema, value, label, valueTypesById)
  return deepFreeze(
    normalizeSchemaValue(schema, value, label, valueTypesById) as Record<string, JsonValue>
  )
}

/** Revalidate and lock tool definitions supplied directly to the runtime. */
export function validateAgentToolsAtStartup(agents: readonly AgentDefinition[]): void {
  for (const agent of agents) {
    if (!isAgentDefinition(agent)) {
      throw new AgentDefinitionError("[Sixb] Agents must contain only valid agent definitions.")
    }

    assertValidAgentToolDefinitions(agent.id, agent.tools)
    for (const tool of agent.tools) {
      deepFreeze(tool.input)
      Object.freeze(tool)
    }
    Object.freeze(agent.tools)
    Object.freeze(agent)
  }
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

export function assertValidAgentReasoning(reasoning: AgentReasoning | undefined): void {
  if (reasoning === undefined) {
    return
  }
  if (!isModelReasoning(reasoning)) {
    throw new AgentDefinitionError(
      `[Sixb] Agent reasoning must be one of: ${AGENT_REASONING_LEVELS.join(", ")}, or a nonnegative budgetTokens object.`
    )
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
  return Object.freeze(groupIds)
}

export function validateAgentGroupReferences(
  agents: readonly AgentDefinition[],
  security: SecurityDefinitionCatalog
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
      const validValues = isValidAgentToolEnumValues(values, schema.valueType)
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

function isAgentToolDefinitionArray(value: unknown): value is readonly AgentToolDefinition[] {
  if (!Array.isArray(value)) {
    return false
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index) || !isAgentToolDefinition(value[index])) {
      return false
    }
  }
  return true
}

export function assertValidAgentToolDefinitions(
  agentId: string,
  tools: readonly AgentToolDefinition[]
): void {
  const seen = new Set<string>()
  for (let index = 0; index < tools.length; index += 1) {
    const tool = tools[index]
    if (!Object.hasOwn(tools, index) || !isAgentToolDefinition(tool)) {
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
  }
}

function isValidAgentToolEnumValues(values: unknown, valueType: unknown): values is unknown[] {
  if (!Array.isArray(values) || values.length === 0) {
    return false
  }

  for (let index = 0; index < values.length; index += 1) {
    if (!Object.hasOwn(values, index)) {
      return false
    }
    const value = values[index]
    if (
      valueType === "string"
        ? typeof value !== "string"
        : valueType !== "integer" || typeof value !== "number" || !Number.isInteger(value)
    ) {
      return false
    }
  }
  return true
}

function deepFreeze<T>(value: T, seen: Set<object> = new Set()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return value
  }

  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor && "value" in descriptor) {
      deepFreeze(descriptor.value, seen)
    }
  }
  return Object.freeze(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
