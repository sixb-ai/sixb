import type { AgentToolDefinition, ValueType } from "@sixb/core"
import { schemaRecordToJsonSchema } from "@sixb/core/internal/ontology"
import { BASH_TOOL_SPEC } from "./bash"
import { READ_TOOL_SPEC } from "./read"
import { VIEW_FILE_TOOL_SPEC } from "./view-file"

/** The exact name, description, and input schema presented to the model for one tool. */
export interface AgentModelToolSpec {
  readonly name: string
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
}

/** Build the model-facing specification shared by execution and context estimation. */
export function agentModelToolSpecFromDefinition(
  definition: AgentToolDefinition,
  valueTypesById: ReadonlyMap<string, ValueType>
): AgentModelToolSpec {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: schemaRecordToJsonSchema({
      shape: definition.input,
      valueTypesById,
    }),
  }
}

/** Describe exactly the tools a conversational model receives, without starting its sandbox. */
export function agentModelToolSpecs(input: {
  readonly definitions: readonly AgentToolDefinition[]
  readonly valueTypesById: ReadonlyMap<string, ValueType>
}): readonly AgentModelToolSpec[] {
  return [
    ...input.definitions.map((definition) =>
      agentModelToolSpecFromDefinition(definition, input.valueTypesById)
    ),
    VIEW_FILE_TOOL_SPEC,
    READ_TOOL_SPEC,
    BASH_TOOL_SPEC,
  ]
}
