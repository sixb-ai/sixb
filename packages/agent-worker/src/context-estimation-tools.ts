import type { AgentToolDefinition, ValueType } from "@sixb/core"
import type { AgentContextEstimateTool } from "@sixb/core/internal/agents"
import { schemaRecordToJsonSchema } from "@sixb/core/internal/ontology"
import { stableJsonStringify } from "@sixb/core/storage"
import type { JSONSchema7 } from "ai"

export const READ_TOOL_DESCRIPTION =
  "Read a UTF-8 text file relative to the sandbox working directory. Returns at most 2,000 lines or 50 KiB and includes nextOffset when more content remains. Prefer this over bash for reading files."

export const READ_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string", description: "Path relative to the sandbox working directory." },
    offset: { type: "integer", minimum: 1, description: "One-based start line. Default: 1." },
    limit: {
      type: "integer",
      minimum: 1,
      description: "Requested line count. Default and maximum: 2,000.",
    },
  },
  required: ["path"],
  additionalProperties: false,
} satisfies JSONSchema7

export const BASH_TOOL_DESCRIPTION = "Run a Bash command in the agent run sandbox."

export const BASH_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    command: { type: "string" },
    cwd: { type: "string" },
    timeoutMs: { type: "number" },
  },
  required: ["command"],
  additionalProperties: false,
} satisfies JSONSchema7

/** Describe exactly the tools the conversational model receives, without starting its sandbox. */
export function agentContextEstimateTools(input: {
  readonly definitions: readonly AgentToolDefinition[]
  readonly valueTypesById: ReadonlyMap<string, ValueType>
}): readonly AgentContextEstimateTool[] {
  return [
    ...input.definitions.map((definition) => ({
      name: definition.name,
      description: definition.description,
      inputSchema: stableJsonStringify(
        schemaRecordToJsonSchema({
          shape: definition.input,
          valueTypesById: input.valueTypesById,
        })
      ),
    })),
    {
      name: "read",
      description: READ_TOOL_DESCRIPTION,
      inputSchema: stableJsonStringify(READ_TOOL_INPUT_SCHEMA),
    },
    {
      name: "bash",
      description: BASH_TOOL_DESCRIPTION,
      inputSchema: stableJsonStringify(BASH_TOOL_INPUT_SCHEMA),
    },
  ]
}
