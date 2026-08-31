import type {
  AgentInboundUiMessagePart,
  AgentMessagePart,
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
import { schemaRecordToJsonSchema } from "@sixb/core/internal/ontology"
import type {
  JsonObject,
  ModelAssistantPart,
  ModelStep,
  ModelTool,
  ModelToolOutput,
  ModelToolResultPart,
  ModelUsage,
} from "@sixb/core/models"
import type { AiModelCallUsageInput } from "@sixb/core/storage"
import { AgentToolExecutionError, AgentToolOutputError } from "./errors"

type AgentErrorDetails =
  | { readonly agentId: string; readonly runId: string }
  | { readonly agentId: string; readonly nodeRunId: string }
  | {
      readonly agentId: string
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
        `[SixbAgentWorker] Agent '${input.run.agentId}' has duplicate selected tool name '${definition.name}'.`,
        {
          details: input.errorDetails ?? {
            agentId: input.run.agentId,
            runId: input.run.id,
          },
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
  const inputSchema = schemaRecordToJsonSchema({
    shape: definition.input,
    valueTypesById: context.valueTypesById,
  }) as JsonObject

  return {
    name: definition.name,
    description: definition.description,
    inputSchema,
    parseInput(value) {
      return validateAndNormalizeAgentToolInput(
        definition.name,
        definition.input,
        value,
        context.valueTypesById
      )
    },
    async execute(toolInput, { signal }) {
      try {
        return await definition.handler({
          input: toolInput,
          signal,
          run: context.run,
          connector: context.connector,
          logger: context.logger,
        })
      } catch (error) {
        if (error instanceof AgentToolResultValidationError) {
          throw new AgentToolOutputError(definition.name, error.reason, { cause: error })
        }
        if (error instanceof AgentToolPublicError) throw error
        throw new AgentToolExecutionError(definition.name, { cause: error })
      }
    },
    errorText: agentToolErrorText,
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
    outcomes.set(part.toolCallId, modelToolOutcome(part.output))
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

/** Map one provider-neutral model call into Sixb's durable accounting vocabulary. */
export function aiModelCallUsageFromModel(usage: ModelUsage): AiModelCallUsageInput {
  return {
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.uncachedInputTokens === undefined
      ? {}
      : { uncachedInputTokens: usage.uncachedInputTokens }),
    ...(usage.cacheReadInputTokens === undefined
      ? {}
      : { cacheReadInputTokens: usage.cacheReadInputTokens }),
    ...(usage.cacheWriteInputTokens === undefined
      ? {}
      : { cacheWriteInputTokens: usage.cacheWriteInputTokens }),
    ...(usage.textOutputTokens === undefined ? {} : { textOutputTokens: usage.textOutputTokens }),
    ...(usage.reasoningOutputTokens === undefined
      ? {}
      : { reasoningOutputTokens: usage.reasoningOutputTokens }),
  }
}
