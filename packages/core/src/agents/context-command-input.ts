import { schemaRecordToJsonSchema } from "../ontology/json-schema"
import type { AgentToolInputSchema, InferAgentToolInputSchema } from "./types"
import { validateAndNormalizeAgentToolInput, validateAndSnapshotAgentToolInput } from "./validation"

export interface AgentContextCommandInput<TInput extends AgentToolInputSchema> {
  readonly inputSchema: Readonly<Record<string, unknown>>
  readonly parse: (input: unknown) => InferAgentToolInputSchema<TInput>
}

/** Compile an inline Sixb input schema for a browser-owned context command. */
export function compileAgentContextCommandInput<const TInput extends AgentToolInputSchema>(
  name: string,
  input: TInput
): AgentContextCommandInput<TInput> {
  const shape = validateAndSnapshotAgentToolInput(name, input)
  return {
    inputSchema: schemaRecordToJsonSchema({ shape, valueTypesById: new Map() }),
    parse(value) {
      // The same schema supplies both type inference and runtime normalization.
      return validateAndNormalizeAgentToolInput(
        name,
        shape,
        value,
        new Map()
      ) as InferAgentToolInputSchema<TInput>
    },
  }
}
