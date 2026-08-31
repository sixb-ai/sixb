import type { BlobBody, FileRef } from "../blob-storage"
import type { ConnectorRuntime } from "../connectors"
import type { JsonPrimitive, JsonValue, ReadonlyJsonValue } from "../json"
import type { Logger } from "../logging"
import type { LanguageModel, ModelReasoningLevel } from "../models"
import type { InferSchema } from "../ontology/inference"
import type { Schema } from "../ontology/types"
import type { GroupDefinition } from "../security"

export type {
  AgentContextEntryInput,
  AgentContextInput,
  AgentContextOrigin,
  AgentContextPart,
} from "./context"

export type AgentReasoningLevel = ModelReasoningLevel

export const AGENT_REASONING_LEVELS = [
  "provider-default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const satisfies readonly AgentReasoningLevel[]

/**
 * Loop / stop controls for an agent run.
 *
 * Consumed by the agent worker when it executes a run.
 */
export interface AgentLoopConfig {
  readonly stopWhen?: {
    readonly maxSteps?: number
  }
}

type Simplify<T> = { [K in keyof T]: T[K] } & {}
type JsonifyAgentToolInput<T> = unknown extends T
  ? ReadonlyJsonValue
  : T extends Date
    ? string
    : T extends readonly (infer TItem)[]
      ? readonly JsonifyAgentToolInput<TItem>[]
      : T extends JsonPrimitive
        ? T
        : T extends object
          ? { readonly [K in keyof T]: JsonifyAgentToolInput<T[K]> }
          : never

/** A model-facing object shape expressed with Sixb's schema DSL. */
export type AgentToolInputSchema = Readonly<Record<string, Schema>>

/** Infer the handler input represented by an agent tool schema. */
export type InferAgentToolInputSchema<TInput extends AgentToolInputSchema> =
  string extends keyof TInput
    ? Readonly<Record<string, unknown>>
    : Simplify<{
        readonly [K in keyof TInput]: JsonifyAgentToolInput<InferSchema<TInput[K]>>
      }>

/** Identifies the agent execution that invoked a tool. */
export interface AgentToolRunInfo {
  readonly id: string
  readonly agentId: string
  readonly threadId?: string
}

/** Input accepted by the run-scoped artifact publisher exposed to agent tools. */
export interface AgentToolArtifactPutInput {
  readonly body: BlobBody
  readonly fileName: string
  readonly mediaType?: string
}

/** A durable artifact and its path inside the current run sandbox. */
export interface AgentToolArtifact {
  readonly fileRef: FileRef
  readonly sandboxPath: string
}

/** The narrow artifact-writing surface available to an agent tool call. */
export interface AgentToolArtifacts {
  put(input: AgentToolArtifactPutInput): Promise<AgentToolArtifact>
}

export type AgentToolTextContent = {
  readonly type: "text"
  readonly text: string
}

export type AgentToolFileContent = {
  readonly type: "file"
  readonly fileRef: FileRef
}

/** Durable model-facing content returned by a file-aware tool. */
export type AgentToolContent = AgentToolTextContent | AgentToolFileContent

/**
 * A file-aware tool result. The tag distinguishes this envelope from an ordinary JSON result while
 * keeping the whole value safe to persist in the durable tool-call trace.
 */
export type AgentToolResult = {
  readonly kind: "agentToolResult"
  readonly content: readonly AgentToolContent[]
}

/** The narrow, run-scoped surface passed to an agent tool handler. */
export interface AgentToolRunContext<
  TInput extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
> {
  readonly input: TInput
  readonly toolCallId: string
  readonly signal: AbortSignal
  readonly run: AgentToolRunInfo
  readonly connector: ConnectorRuntime
  readonly logger: Logger
  readonly artifacts: AgentToolArtifacts
}

/** Agent tool handlers may return only values safe to persist in agent messages. */
export type AgentToolHandlerResult =
  | ReadonlyJsonValue
  | AgentToolResult
  | Promise<ReadonlyJsonValue | AgentToolResult>

export type AgentToolHandler<TInput extends Readonly<Record<string, unknown>>> = (
  context: AgentToolRunContext<TInput>
) => AgentToolHandlerResult

/**
 * Runtime definitions are stored heterogeneously. Keep variance erasure at this
 * boundary only; authoring through `run()` remains strictly contravariant.
 */
type StoredAgentToolHandler<TInput extends Readonly<Record<string, unknown>>> = {
  bivarianceHack(context: AgentToolRunContext<TInput>): JsonValue | Promise<JsonValue>
}["bivarianceHack"]

/** A reusable, inert model tool definition selected explicitly by an agent. */
export interface AgentToolDefinition<
  TName extends string = string,
  TInput extends AgentToolInputSchema = AgentToolInputSchema,
> {
  readonly kind: "agentTool"
  readonly name: TName
  readonly description: string
  readonly input: TInput
  readonly handler: StoredAgentToolHandler<InferAgentToolInputSchema<TInput>>
}

/** Infer the input received by a tool definition's handler. */
export type InferAgentToolInput<TTool extends AgentToolDefinition> = InferAgentToolInputSchema<
  TTool["input"]
>

export interface AgentToolRunBuilder<TName extends string, TInput extends AgentToolInputSchema> {
  run(
    handler: AgentToolHandler<InferAgentToolInputSchema<TInput>>
  ): AgentToolDefinition<TName, TInput>
}

export interface AgentToolInputBuilder<TName extends string> {
  input<const TInput extends AgentToolInputSchema>(
    input: TInput
  ): AgentToolRunBuilder<TName, TInput>
}

export interface AgentToolDescriptionBuilder<TName extends string> {
  description(description: string): AgentToolInputBuilder<TName>
}

/**
 * Declarative config accepted by {@link defineAgent}.
 *
 * Every field is a static value. `instructions` is a plain string; widening it to
 * `string | (ctx) => string` later would be backwards-compatible.
 */
export interface DefineAgentConfig {
  readonly name: string
  readonly description?: string
  readonly model: LanguageModel
  readonly reasoning?: AgentReasoningLevel
  readonly instructions: string
  readonly groups?: readonly GroupDefinition[]
  /** Reusable tools this agent is explicitly allowed to call. */
  readonly tools?: readonly AgentToolDefinition[]
  readonly loop?: AgentLoopConfig
}

/**
 * Agent definition registered with Sixb.
 *
 * Definitions are safe to export from `agents/` modules; the runtime loads and
 * registers them. The agent worker runs them as streaming turns. The `model` is a language model
 * instance and is therefore not serialisable — the worker
 * resolves a definition from its own discovery rather than over the wire.
 */
export interface AgentDefinition<TId extends string = string> {
  readonly kind: "agent"
  readonly id: TId
  readonly name: string
  readonly description?: string
  readonly model: LanguageModel
  readonly reasoning?: AgentReasoningLevel
  readonly instructions: string
  readonly groupIds: readonly string[]
  /** Selected tool definitions, normalized to an empty array when omitted. */
  readonly tools: readonly AgentToolDefinition[]
  readonly loop?: AgentLoopConfig
}
