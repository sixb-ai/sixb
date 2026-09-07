import type { JsonObject, JsonValue } from "../json"
import type { ModelToolOutput } from "./messages"

export interface ModelToolExecutionContext {
  readonly signal: AbortSignal
  readonly callId: string
  readonly toolCallId: string
}

export interface ModelTool<TInput = unknown, TOutput extends JsonValue = JsonValue> {
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonObject
  parseInput(value: unknown): TInput
  execute(input: TInput, context: ModelToolExecutionContext): Promise<TOutput>
  /** Project a durable output into provider-safe model content without changing the stored result. */
  toModelOutput?(
    output: TOutput,
    context: ModelToolExecutionContext
  ): ModelToolOutput | Promise<ModelToolOutput>
  errorText(error: unknown): string
}

export interface ModelOutput<TOutput> {
  readonly name: string
  readonly description?: string
  readonly schema: JsonObject
  validate(value: unknown): TOutput
}
