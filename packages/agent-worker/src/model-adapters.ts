import type {
  AgentInboundUiMessagePart,
  AgentMessagePart,
  AgentToolArtifacts,
  AgentToolDefinition,
  AgentToolRunContext,
  AgentToolRunInfo,
  JsonValue,
  Logger,
  ValueType,
} from "@sixb/core"
import { AgentToolPublicError } from "@sixb/core"
import {
  AgentToolResultValidationError,
  fromUiMessage,
  validateAndNormalizeAgentToolInput,
} from "@sixb/core/internal/agents"
import { createSixbError } from "@sixb/core/internal/errors"
import type {
  JsonObject,
  ModelAssistantPart,
  ModelStep,
  ModelTool,
  ModelToolOutput,
  ModelToolResultPart,
} from "@sixb/core/models"
import { AgentToolExecutionError, AgentToolOutputError } from "./errors"
import { agentModelToolSpecFromDefinition } from "./tools/model-spec"
import type { AgentToolModelOutput } from "./tools/result-output"

export type AgentErrorDetails =
  | { readonly threadId: string; readonly runId: string }
  | { readonly parentRunId: string; readonly runId: string }
  | { readonly workflowId: string; readonly agentStepId: string; readonly runId: string }
  | {
      readonly agentStepId: string
      readonly workflowId: string
      readonly workflowRunId: string
      readonly nodeRunId: string
    }

interface ModelToolsFromAgentDefinitionsInput {
  readonly definitions: readonly AgentToolDefinition[]
  readonly valueTypesById: ReadonlyMap<string, ValueType>
  readonly run: AgentToolRunInfo
  readonly connector: AgentToolRunContext["connector"]
  readonly logger: Logger
  readonly artifactsForToolCall: (input: {
    readonly toolName: string
    readonly toolCallId: string
    readonly signal: AbortSignal
  }) => AgentToolArtifacts
  readonly toolResultToModelOutput: (input: {
    readonly output: JsonValue
    readonly signal: AbortSignal
    readonly toolCallId: string
  }) => AgentToolModelOutput | Promise<AgentToolModelOutput>
  readonly errorDetails?: AgentErrorDetails
}

/** Adapt an agent's selected Sixb definitions to the owned model tool contract. */
export function modelToolsFromAgentDefinitions(
  input: ModelToolsFromAgentDefinitionsInput
): readonly ModelTool[] {
  const names = new Set<string>()
  return input.definitions.map((definition) => {
    if (names.has(definition.name)) {
      throw createSixbError(
        "internal.unexpected",
        `[SixbAgentWorker] Agent run '${input.run.id}' has duplicate selected tool name '${definition.name}'.`,
        {
          details: input.errorDetails ?? agentToolRunErrorDetails(input.run),
        }
      )
    }
    names.add(definition.name)
    return modelToolFromAgentDefinition(definition, input)
  })
}

function modelToolFromAgentDefinition(
  definition: AgentToolDefinition,
  context: Omit<ModelToolsFromAgentDefinitionsInput, "definitions">
): ModelTool<Readonly<Record<string, unknown>>> {
  const spec = agentModelToolSpecFromDefinition(definition, context.valueTypesById)

  return {
    ...spec,
    inputSchema: spec.inputSchema as JsonObject,
    parseInput(value) {
      return validateAndNormalizeAgentToolInput(
        definition.name,
        definition.input,
        value,
        context.valueTypesById
      )
    },
    async execute(toolInput, { signal, toolCallId }) {
      try {
        return await definition.handler({
          input: toolInput,
          toolCallId,
          signal,
          run: context.run,
          connector: context.connector,
          logger: context.logger,
          artifacts: context.artifactsForToolCall({
            toolName: definition.name,
            toolCallId,
            signal,
          }),
        })
      } catch (error) {
        if (error instanceof AgentToolResultValidationError) {
          throw new AgentToolOutputError(definition.name, error.reason, { cause: error })
        }
        if (error instanceof AgentToolPublicError) throw error
        throw new AgentToolExecutionError(definition.name, { cause: error })
      }
    },
    toModelOutput(output, { signal, toolCallId }) {
      return context.toolResultToModelOutput({ output, signal, toolCallId })
    },
    errorText: agentToolErrorText,
  }
}

function agentToolRunErrorDetails(run: AgentToolRunInfo): AgentErrorDetails {
  switch (run.kind) {
    case "conversation":
      return { threadId: run.threadId, runId: run.id }
    case "subagent":
      return { parentRunId: run.parentRunId, runId: run.id }
    case "workflow":
      return { workflowId: run.workflowId, agentStepId: run.stepId, runId: run.id }
  }
}

type ToolOutcome =
  | { readonly state: "output-available"; readonly output: JsonValue }
  | { readonly state: "output-error"; readonly errorText: string }

/** Convert complete model-loop steps into Sixb's durable, JSON-validated trace contract. */
export function agentTraceFromModelSteps(
  steps: readonly ModelStep[],
  errorDetails?: AgentErrorDetails
): readonly AgentMessagePart[] {
  const parts = steps.flatMap((step) => tracePartsFromModelContent(step.content, errorDetails))
  return fromUiMessage({ role: "assistant", parts }).parts
}

/** Convert an aborted model loop, retaining only coherent content from its in-flight step. */
export function agentTraceFromPartialModelLoop(
  steps: readonly ModelStep[],
  partialContent: readonly ModelAssistantPart[],
  errorDetails?: AgentErrorDetails
): readonly AgentMessagePart[] {
  const parts = [
    ...steps.flatMap((step) => tracePartsFromModelContent(step.content, errorDetails)),
    ...(partialContent.length === 0
      ? []
      : tracePartsFromModelContent(partialContent, errorDetails, "Tool execution was cancelled.")),
  ]
  return fromUiMessage({ role: "assistant", parts }).parts
}

function tracePartsFromModelContent(
  content: readonly (ModelAssistantPart | ModelToolResultPart)[],
  errorDetails?: AgentErrorDetails,
  missingToolResultText = "Tool call did not produce a result."
): AgentInboundUiMessagePart[] {
  const outcomes = indexToolOutcomes(content)
  return [
    { type: "step-start" },
    ...content.flatMap((part): AgentInboundUiMessagePart[] => {
      switch (part.type) {
        case "text":
        case "reasoning":
          return [
            {
              type: part.type,
              text: part.text,
              ...(part.providerData === undefined ? {} : { providerMetadata: part.providerData }),
            },
          ]
        case "provider-state":
          return [{ type: "provider-state", providerId: part.providerId, data: part.data }]
        case "tool-call": {
          const outcome = outcomes.get(part.toolCallId) ?? {
            state: "output-error" as const,
            errorText: missingToolResultText,
          }
          return [
            {
              type: part.dynamic === true ? "dynamic-tool" : `tool-${part.toolName}`,
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input,
              ...(part.providerExecuted === undefined
                ? {}
                : { providerExecuted: part.providerExecuted }),
              ...(part.providerData === undefined
                ? {}
                : { callProviderMetadata: part.providerData }),
              ...outcome,
            },
          ]
        }
        case "tool-result":
          return []
        default:
          return assertUnreachableModelPart(part, errorDetails)
      }
    }),
  ]
}

function indexToolOutcomes(
  content: readonly (ModelAssistantPart | ModelToolResultPart)[]
): ReadonlyMap<string, ToolOutcome> {
  const outcomes = new Map<string, ToolOutcome>()
  for (const part of content) {
    if (part.type !== "tool-result") continue
    outcomes.set(
      part.toolCallId,
      part.originalOutput === undefined
        ? modelToolOutcome(part.output)
        : { state: "output-available", output: part.originalOutput }
    )
  }
  return outcomes
}

function modelToolOutcome(output: ModelToolOutput): ToolOutcome {
  switch (output.type) {
    case "text":
      return { state: "output-available", output: output.value }
    case "json":
      return { state: "output-available", output: output.value }
    case "error-text":
      return { state: "output-error", errorText: output.value }
    case "error-json":
      return { state: "output-error", errorText: JSON.stringify(output.value) }
  }
}

function assertUnreachableModelPart(
  part: never,
  errorDetails?: AgentErrorDetails
): AgentInboundUiMessagePart[] {
  throw createSixbError(
    "internal.unexpected",
    `[SixbAgentWorker] Model trace content '${(part as { type?: unknown }).type}' is not supported.`,
    errorDetails === undefined ? undefined : { details: errorDetails }
  )
}

/** Expose only failures that the tool author explicitly marked as safe for the model and storage. */
export function agentToolErrorText(error: unknown): string {
  return error instanceof AgentToolPublicError ? error.message : "An error occurred."
}
