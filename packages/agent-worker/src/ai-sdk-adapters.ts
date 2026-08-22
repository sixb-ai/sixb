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
  fromAiSdk,
  validateAndNormalizeAgentToolInput,
} from "@sixb/core/internal/agents"
import { createSixbError } from "@sixb/core/internal/errors"
import { schemaRecordToJsonSchema } from "@sixb/core/internal/ontology"
import type { AiModelCallUsageInput } from "@sixb/core/storage"
import { jsonSchema, type LanguageModelUsage, type Tool, type ToolSet, tool } from "ai"
import { AgentToolExecutionError, AgentToolOutputError } from "./errors"

const NEVER_ABORTED_SIGNAL = new AbortController().signal

type AgentErrorDetails =
  | { readonly agentId: string; readonly runId: string }
  | { readonly agentId: string; readonly nodeRunId: string }
  | {
      readonly agentId: string
      readonly workflowId: string
      readonly workflowRunId: string
      readonly nodeRunId: string
    }

interface AiSdkToolsFromAgentDefinitionsInput {
  readonly definitions: readonly AgentToolDefinition[]
  readonly valueTypesById: ReadonlyMap<string, ValueType>
  readonly run: AgentToolRunInfo
  readonly connector: AgentToolRunContext["connector"]
  readonly logger: Logger
  readonly errorDetails?: AgentErrorDetails
}

/** Adapt one agent's explicitly selected Sixb definitions to executable AI SDK tools. */
export function aiSdkToolsFromAgentDefinitions(
  input: AiSdkToolsFromAgentDefinitionsInput
): ToolSet {
  const tools = emptyToolSet()
  for (const definition of input.definitions) {
    if (Object.hasOwn(tools, definition.name)) {
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
    tools[definition.name] = aiSdkToolFromAgentDefinition(definition, input)
  }
  return tools
}

function aiSdkToolFromAgentDefinition(
  definition: AgentToolDefinition,
  context: Omit<AiSdkToolsFromAgentDefinitionsInput, "definitions">
): Tool<Record<string, unknown>, JsonValue> {
  return tool({
    description: definition.description,
    inputSchema: aiSdkInputSchemaFromAgentDefinition(
      definition,
      context.valueTypesById,
      context.errorDetails ?? { agentId: context.run.agentId, runId: context.run.id }
    ),
    async execute(input, { abortSignal }) {
      let result: JsonValue
      try {
        result = await definition.handler({
          input,
          signal: abortSignal ?? NEVER_ABORTED_SIGNAL,
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
      return result
    },
  })
}

function aiSdkInputSchemaFromAgentDefinition(
  definition: AgentToolDefinition,
  valueTypesById: ReadonlyMap<string, ValueType>,
  errorDetails: AgentErrorDetails
) {
  const inputSchema = schemaRecordToJsonSchema({ shape: definition.input, valueTypesById })
  return jsonSchema<Record<string, unknown>>(inputSchema as Parameters<typeof jsonSchema>[0], {
    validate(value) {
      try {
        return {
          success: true,
          value: validateAndNormalizeAgentToolInput(
            definition.name,
            definition.input,
            value,
            valueTypesById
          ),
        }
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof Error
              ? error
              : createSixbError(
                  "internal.unexpected",
                  `[SixbAgentWorker] Agent tool '${definition.name}' input validation failed.`,
                  {
                    cause: error,
                    details: errorDetails,
                  }
                ),
        }
      }
    },
  })
}

function emptyToolSet(): ToolSet {
  // Tool names may legally be `__proto__`; a null prototype keeps every valid name an own property.
  return Object.create(null) as ToolSet
}

/** Minimal structural boundary implemented by AI SDK StepResult content. */
export interface AiSdkTraceStep {
  readonly content: readonly AiSdkTraceContentPart[]
}

interface AiSdkTraceContentPart {
  readonly type: string
  readonly text?: string
  readonly toolCallId?: string
  readonly toolName?: string
  readonly input?: unknown
  readonly output?: unknown
  readonly error?: unknown
  readonly dynamic?: boolean
  readonly providerExecuted?: boolean
  readonly providerMetadata?: unknown
}

type ToolOutcome =
  | { readonly state: "output-available"; readonly output: unknown }
  | { readonly state: "output-error"; readonly errorText: string }

/** Convert final AI SDK steps into Sixb's durable, JSON-validated trace contract. */
export function agentTraceFromAiSdkSteps(
  steps: readonly AiSdkTraceStep[],
  errorDetails?: AgentErrorDetails
): readonly AgentMessagePart[] {
  const parts = steps.flatMap((step) => agentTracePartsFromAiSdkStep(step, errorDetails))
  return fromAiSdk({ role: "assistant", parts }).parts
}

function agentTracePartsFromAiSdkStep(
  step: AiSdkTraceStep,
  errorDetails?: AgentErrorDetails
): AgentInboundUiMessagePart[] {
  const toolOutcomes = indexToolOutcomes(step.content, errorDetails)
  return [
    { type: "step-start" },
    ...step.content.flatMap((part) =>
      agentTracePartsFromAiSdkContent(part, toolOutcomes, errorDetails)
    ),
  ]
}

function indexToolOutcomes(
  content: readonly AiSdkTraceContentPart[],
  errorDetails?: AgentErrorDetails
): ReadonlyMap<string, ToolOutcome> {
  const outcomes = new Map<string, ToolOutcome>()
  for (const part of content) {
    if (part.type !== "tool-result" && part.type !== "tool-error") continue
    const toolCallId = requireNonEmptyString(
      part.toolCallId,
      `${part.type}.toolCallId`,
      errorDetails
    )
    outcomes.set(
      toolCallId,
      part.type === "tool-result"
        ? { state: "output-available", output: part.output }
        : { state: "output-error", errorText: agentToolErrorText(part.error) }
    )
  }
  return outcomes
}

function agentTracePartsFromAiSdkContent(
  part: AiSdkTraceContentPart,
  toolOutcomes: ReadonlyMap<string, ToolOutcome>,
  errorDetails?: AgentErrorDetails
): AgentInboundUiMessagePart[] {
  switch (part.type) {
    case "text":
    case "reasoning":
      return [
        {
          type: part.type,
          text: requireString(part.text, `${part.type}.text`, errorDetails),
          ...(part.providerMetadata === undefined
            ? {}
            : { providerMetadata: part.providerMetadata }),
        },
      ]
    case "tool-call":
      return [toolCallTracePart(part, toolOutcomes, errorDetails)]
    case "tool-result":
    case "tool-error":
      // Results are folded into their tool-call part, which is Sixb's durable representation.
      return []
    default:
      throw createSixbError(
        "internal.unexpected",
        `[SixbAgentWorker] AI SDK trace content '${part.type}' is not supported by the durable agent trace contract.`,
        errorDetails === undefined ? undefined : { details: errorDetails }
      )
  }
}

function toolCallTracePart(
  part: AiSdkTraceContentPart,
  outcomes: ReadonlyMap<string, ToolOutcome>,
  errorDetails?: AgentErrorDetails
): AgentInboundUiMessagePart {
  const toolCallId = requireNonEmptyString(part.toolCallId, "tool-call.toolCallId", errorDetails)
  const toolName = requireNonEmptyString(part.toolName, "tool-call.toolName", errorDetails)
  const outcome =
    outcomes.get(toolCallId) ??
    (part.error === undefined
      ? { state: "output-error" as const, errorText: "Tool call did not produce a result." }
      : { state: "output-error" as const, errorText: agentToolErrorText(part.error) })

  return {
    type: part.dynamic === true ? "dynamic-tool" : `tool-${toolName}`,
    toolCallId,
    toolName,
    input: part.input,
    ...(part.providerExecuted === undefined ? {} : { providerExecuted: part.providerExecuted }),
    ...(part.providerMetadata === undefined ? {} : { callProviderMetadata: part.providerMetadata }),
    ...outcome,
  }
}

function requireString(value: unknown, field: string, errorDetails?: AgentErrorDetails): string {
  if (typeof value !== "string") {
    throw createSixbError(
      "internal.unexpected",
      `[SixbAgentWorker] AI SDK trace ${field} must be a string.`,
      errorDetails === undefined ? undefined : { details: errorDetails }
    )
  }
  return value
}

function requireNonEmptyString(
  value: unknown,
  field: string,
  errorDetails?: AgentErrorDetails
): string {
  const string = requireString(value, field, errorDetails)
  if (!string) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbAgentWorker] AI SDK trace ${field} must not be empty.`,
      errorDetails === undefined ? undefined : { details: errorDetails }
    )
  }
  return string
}

/** Expose only failures that the tool author explicitly marked as safe for the model and storage. */
export function agentToolErrorText(error: unknown): string {
  return error instanceof AgentToolPublicError ? error.message : "An error occurred."
}

/** Preserve every provider-neutral count from one AI SDK model call without inventing zeroes. */
export function aiModelCallUsageFromAiSdk(usage: LanguageModelUsage): AiModelCallUsageInput {
  return {
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.inputTokenDetails.noCacheTokens === undefined
      ? {}
      : { uncachedInputTokens: usage.inputTokenDetails.noCacheTokens }),
    ...(usage.inputTokenDetails.cacheReadTokens === undefined
      ? {}
      : { cacheReadInputTokens: usage.inputTokenDetails.cacheReadTokens }),
    ...(usage.inputTokenDetails.cacheWriteTokens === undefined
      ? {}
      : { cacheWriteInputTokens: usage.inputTokenDetails.cacheWriteTokens }),
    ...(usage.outputTokenDetails.textTokens === undefined
      ? {}
      : { textOutputTokens: usage.outputTokenDetails.textTokens }),
    ...(usage.outputTokenDetails.reasoningTokens === undefined
      ? {}
      : { reasoningOutputTokens: usage.outputTokenDetails.reasoningTokens }),
  }
}
