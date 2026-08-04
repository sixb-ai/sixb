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
import {
  AgentToolResultValidationError,
  fromAiSdk,
  validateAndNormalizeAgentToolInput,
} from "@sixb/core/internal/agents"
import { schemaRecordToJsonSchema } from "@sixb/core/internal/ontology"
import type { AgentRunUsage } from "@sixb/core/storage"
import { jsonSchema, type LanguageModelUsage, type Tool, type ToolSet, tool } from "ai"
import { AgentToolOutputError, AgentWorkerError } from "./errors"

const NEVER_ABORTED_SIGNAL = new AbortController().signal

interface AiSdkToolsFromAgentDefinitionsInput {
  readonly definitions: readonly AgentToolDefinition[]
  readonly valueTypesById: ReadonlyMap<string, ValueType>
  readonly run: AgentToolRunInfo
  readonly connector: AgentToolRunContext["connector"]
  readonly logger: Logger
}

/** Adapt one agent's explicitly selected Sixb definitions to executable AI SDK tools. */
export function aiSdkToolsFromAgentDefinitions(
  input: AiSdkToolsFromAgentDefinitionsInput
): ToolSet {
  const tools = emptyToolSet()
  for (const definition of input.definitions) {
    if (Object.hasOwn(tools, definition.name)) {
      throw new AgentWorkerError(
        `Agent '${input.run.agentId}' has duplicate selected tool name '${definition.name}'.`
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
    inputSchema: aiSdkInputSchemaFromAgentDefinition(definition, context.valueTypesById),
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
        throw error
      }
      return result
    },
  })
}

function aiSdkInputSchemaFromAgentDefinition(
  definition: AgentToolDefinition,
  valueTypesById: ReadonlyMap<string, ValueType>
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
              : new AgentWorkerError(`Agent tool '${definition.name}' input validation failed.`, {
                  cause: error,
                }),
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
  steps: readonly AiSdkTraceStep[]
): readonly AgentMessagePart[] {
  const parts = steps.flatMap(agentTracePartsFromAiSdkStep)
  return fromAiSdk({ role: "assistant", parts }).parts
}

function agentTracePartsFromAiSdkStep(step: AiSdkTraceStep): AgentInboundUiMessagePart[] {
  const toolOutcomes = indexToolOutcomes(step.content)
  return [
    { type: "step-start" },
    ...step.content.flatMap((part) => agentTracePartsFromAiSdkContent(part, toolOutcomes)),
  ]
}

function indexToolOutcomes(
  content: readonly AiSdkTraceContentPart[]
): ReadonlyMap<string, ToolOutcome> {
  const outcomes = new Map<string, ToolOutcome>()
  for (const part of content) {
    if (part.type !== "tool-result" && part.type !== "tool-error") continue
    const toolCallId = requireNonEmptyString(part.toolCallId, `${part.type}.toolCallId`)
    outcomes.set(
      toolCallId,
      part.type === "tool-result"
        ? { state: "output-available", output: part.output }
        : { state: "output-error", errorText: errorText(part.error) }
    )
  }
  return outcomes
}

function agentTracePartsFromAiSdkContent(
  part: AiSdkTraceContentPart,
  toolOutcomes: ReadonlyMap<string, ToolOutcome>
): AgentInboundUiMessagePart[] {
  switch (part.type) {
    case "text":
    case "reasoning":
      return [
        {
          type: part.type,
          text: requireString(part.text, `${part.type}.text`),
          ...(part.providerMetadata === undefined
            ? {}
            : { providerMetadata: part.providerMetadata }),
        },
      ]
    case "tool-call":
      return [toolCallTracePart(part, toolOutcomes)]
    case "tool-result":
    case "tool-error":
      // Results are folded into their tool-call part, which is Sixb's durable representation.
      return []
    default:
      throw new AgentWorkerError(
        `AI SDK trace content '${part.type}' is not supported by the durable agent trace contract.`
      )
  }
}

function toolCallTracePart(
  part: AiSdkTraceContentPart,
  outcomes: ReadonlyMap<string, ToolOutcome>
): AgentInboundUiMessagePart {
  const toolCallId = requireNonEmptyString(part.toolCallId, "tool-call.toolCallId")
  const toolName = requireNonEmptyString(part.toolName, "tool-call.toolName")
  const outcome =
    outcomes.get(toolCallId) ??
    (part.error === undefined
      ? { state: "output-error" as const, errorText: "Tool call did not produce a result." }
      : { state: "output-error" as const, errorText: errorText(part.error) })

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

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new AgentWorkerError(`AI SDK trace ${field} must be a string.`)
  }
  return value
}

function requireNonEmptyString(value: unknown, field: string): string {
  const string = requireString(value, field)
  if (!string) {
    throw new AgentWorkerError(`AI SDK trace ${field} must not be empty.`)
  }
  return string
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  try {
    const serialized = JSON.stringify(error)
    return serialized === undefined ? String(error) : serialized
  } catch {
    return String(error)
  }
}

/** Map AI SDK accounting onto Sixb's provider-independent durable usage vocabulary. */
export function agentRunUsageFromAiSdk(usage: LanguageModelUsage): AgentRunUsage | undefined {
  const mapped: AgentRunUsage = {
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
    ...(usage.outputTokenDetails.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: usage.outputTokenDetails.reasoningTokens }),
    ...(usage.inputTokenDetails.cacheReadTokens === undefined
      ? {}
      : { cachedInputTokens: usage.inputTokenDetails.cacheReadTokens }),
  }
  return Object.keys(mapped).length > 0 ? mapped : undefined
}
