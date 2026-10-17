import type { ActionsRuntime } from "../actions/execution"
import type { BlobBody, FileRef, OpenedFileRef } from "../blob-storage"
import type { ConnectorRuntime } from "../connectors"
import type { JsonPrimitive, JsonValue, ReadonlyJsonValue } from "../json"
import type { Logger } from "../logging"
import { type LanguageModelRef, MODEL_REASONING_LEVELS, type ModelReasoning } from "../models"
import type { ModelsRuntime } from "../models/generation-types"
import type { InferSchema } from "../ontology/inference"
import type { Schema } from "../ontology/types"
import type { ObjectReader } from "../runtime/types"

export type {
  AgentContextEntryInput,
  AgentContextInput,
  AgentContextOrigin,
  AgentContextPart,
} from "./context/entries"

/** Public capability reference used by security grants such as `can.run(agent)`. */
export interface AgentReference {
  readonly kind: "agent"
  readonly usage: AgentUsageReference
}

/** Project-wide AI accounting and limit capability, independent of permission to run the Agent. */
export interface AgentUsageReference {
  readonly kind: "aiUsage"
}

/** Public metadata for the project's conversational Agent. */
export interface AgentDescriptor {
  readonly name: string
  readonly model: LanguageModelRef
}

export type AgentReasoning = ModelReasoning

export const AGENT_REASONING_LEVELS = MODEL_REASONING_LEVELS

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

/** Identifies the conversational, workflow, or child Agent execution that invoked a tool. */
export type AgentToolRunInfo =
  | {
      readonly kind: "conversation"
      readonly id: string
      readonly threadId: string
    }
  | {
      readonly kind: "subagent"
      readonly id: string
      readonly parentRunId: string
    }
  | {
      readonly kind: "workflow"
      readonly id: string
      readonly workflowId: string
      readonly stepId: string
    }

/** Input accepted by the run-scoped file publisher exposed to agent tools. */
export interface AgentToolFilePutInput {
  readonly body: BlobBody
  readonly fileName: string
  readonly mediaType?: string
}

/** A file a tool stored durably, and the path of its copy inside the current run sandbox. */
export interface AgentToolFile {
  readonly fileRef: FileRef
  readonly sandboxPath: string
}

/** The narrow file-writing surface available to an agent tool call. */
export interface AgentToolFiles {
  put(input: AgentToolFilePutInput): Promise<AgentToolFile>
}

/**
 * The files attached to the run that invoked a tool: the messages of a chat's thread, or the input
 * files of a workflow AI task. A child Agent has none.
 */
export interface AgentToolAttachments {
  /**
   * Open an attachment by the `key` the Agent sees in `$SIXB_ATTACHMENTS`. Returns null when its
   * stored file is gone, and throws an `AgentToolPublicError` for a key that is not one of this
   * run's attachments.
   */
  open(key: string): Promise<OpenedFileRef | null>
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

/**
 * The run's domain SDK as an agent tool sees it. Unlike workflow steps and actions, it acts as the
 * run's requester: the signed-in user in a chat, that same user in a child Agent, and the step's
 * groups in a workflow AI task.
 *
 * A structural view of the public `Sixb` SDK, like `WorkflowRuntimeFacade`: the handler receives the
 * run's bound SDK, and this type guides it to what a tool should do. It reads objects and changes
 * them by requesting actions, which validate and record the change. Authority comes from the run,
 * not from this view.
 */
export interface AgentToolRuntimeFacade extends ObjectReader {
  readonly actions: ActionsRuntime
  readonly models: ModelsRuntime
  readonly connector: ConnectorRuntime
}

/** The narrow, run-scoped surface passed to an agent tool handler. */
export interface AgentToolRunContext<
  TInput extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
> {
  readonly input: TInput
  readonly toolCallId: string
  readonly signal: AbortSignal
  readonly run: AgentToolRunInfo
  readonly sixb: AgentToolRuntimeFacade
  readonly logger: Logger
  readonly files: AgentToolFiles
  readonly attachments: AgentToolAttachments
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
