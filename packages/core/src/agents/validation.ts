import { getInvalidJsonValueReason, isPlainRecord, type JsonValue } from "../json"
import { type ObjectSchema, OntologyValidationError, type ValueType } from "../ontology"
import { assertValidSchema } from "../ontology/validation/definition"
import { normalizeSchemaValue } from "../ontology/validation/normalize"
import { validateSchemaValue } from "../ontology/validation/schema"
import { AgentDefinitionError } from "./errors"
import type { AgentToolDefinition, AgentToolInputSchema } from "./types"

const AGENT_TOOL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/
export const AGENT_RESERVED_TOOL_NAMES = [
  "bash",
  "read",
  "view_file",
  "spawn_agent",
  "wait_agent",
] as const

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
    assertValidSchema(schema, `input.${field}`, (path) => invalidAgentToolSchema(name, path))
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

function invalidAgentToolSchema(toolName: string, path: string): AgentDefinitionError {
  return new AgentDefinitionError(
    `[Sixb] Agent tool '${toolName}' ${path} must be a valid Sixb schema.`
  )
}

export function assertValidProjectAgentToolDefinitions(
  tools: readonly AgentToolDefinition[]
): void {
  const seen = new Set<string>()
  for (let index = 0; index < tools.length; index += 1) {
    const tool = tools[index]
    if (!Object.hasOwn(tools, index) || !isAgentToolDefinition(tool)) {
      throw new AgentDefinitionError(
        "[Sixb] Project tools must contain only agent tool definitions."
      )
    }

    assertValidAgentToolName(tool.name)
    assertValidAgentToolDescription(tool.name, tool.description)
    assertValidAgentToolInput(tool.name, tool.input)
    if (seen.has(tool.name)) {
      throw new AgentDefinitionError(
        `[Sixb] Project tools contain duplicate tool name '${tool.name}'.`
      )
    }
    seen.add(tool.name)
  }
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
