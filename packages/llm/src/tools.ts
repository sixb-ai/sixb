import type { JsonObject, JsonValue } from "./json"

export interface ModelToolExecutionContext {
  readonly signal: AbortSignal
  readonly callId: string
}

export interface ModelTool<TInput = unknown, TOutput extends JsonValue = JsonValue> {
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonObject
  parseInput(value: unknown): TInput
  execute(input: TInput, context: ModelToolExecutionContext): Promise<TOutput>
  errorText(error: unknown): string
}

export interface ModelOutput<TOutput> {
  readonly name: string
  readonly description?: string
  readonly schema: JsonObject
  validate(value: unknown): TOutput
}
