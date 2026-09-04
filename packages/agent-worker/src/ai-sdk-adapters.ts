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
  fromAiSdk,
  validateAndNormalizeAgentToolInput,
} from "@sixb/core/internal/agents"
import { createSixbError } from "@sixb/core/internal/errors"
import type { AiModelCallUsageInput, AiPricingContext } from "@sixb/core/storage"
import {
  jsonSchema,
  type LanguageModelCallStartEvent,
  type LanguageModelUsage,
  type Tool,
  type ToolSet,
  tool,
} from "ai"
import { NEVER_ABORTED_SIGNAL } from "./abort"
import { AgentToolExecutionError, AgentToolOutputError } from "./errors"
import { type AgentModelToolSpec, agentModelToolSpecFromDefinition } from "./tools/model-spec"
import type { AgentToolModelOutput } from "./tools/result-output"

export type AgentErrorDetails =
  | { readonly agentId: string; readonly runId: string }
  | {
      readonly agentStepId: string
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
  readonly artifactsForToolCall: (input: {
    readonly toolName: string
    readonly toolCallId: string
    readonly signal: AbortSignal
  }) => AgentToolArtifacts
  readonly toolResultToModelOutput: (input: {
    readonly output: JsonValue
    readonly signal: AbortSignal
    readonly toolCallId: string
  }) => AgentToolModelOutput | PromiseLike<AgentToolModelOutput>
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
  const signalsByToolCallId = new Map<string, AbortSignal>()
  const spec = agentModelToolSpecFromDefinition(definition, context.valueTypesById)
  return tool({
    description: spec.description,
    inputSchema: aiSdkInputSchemaFromAgentDefinition(
      definition,
      spec.inputSchema,
      context.valueTypesById,
      context.errorDetails ?? { agentId: context.run.agentId, runId: context.run.id }
    ),
    async execute(input, { abortSignal, toolCallId }) {
      let result: JsonValue
      const signal = abortSignal ?? NEVER_ABORTED_SIGNAL
      signalsByToolCallId.set(toolCallId, signal)
      try {
        result = await definition.handler({
          input,
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
        signalsByToolCallId.delete(toolCallId)
        if (error instanceof AgentToolResultValidationError) {
          throw new AgentToolOutputError(definition.name, error.reason, { cause: error })
        }
        if (error instanceof AgentToolPublicError) throw error
        throw new AgentToolExecutionError(definition.name, { cause: error })
      }
      return result
    },
    async toModelOutput({ output, toolCallId }) {
      const signal = signalsByToolCallId.get(toolCallId) ?? NEVER_ABORTED_SIGNAL
      try {
        return await context.toolResultToModelOutput({ output, toolCallId, signal })
      } finally {
        signalsByToolCallId.delete(toolCallId)
      }
    },
  })
}

function aiSdkInputSchemaFromAgentDefinition(
  definition: AgentToolDefinition,
  inputSchema: AgentModelToolSpec["inputSchema"],
  valueTypesById: ReadonlyMap<string, ValueType>,
  errorDetails: AgentErrorDetails
) {
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

/** Snapshot only explicitly allowlisted billing dimensions from request-side provider options. */
export function aiPricingContextFromAiSdkCallStart(
  event: Pick<LanguageModelCallStartEvent, "provider">,
  providerOptions: unknown
): AiPricingContext {
  if (!isUnknownRecord(providerOptions)) return {}
  const options = providerOptions[providerOptionsKey(event.provider)]
  if (!isUnknownRecord(options)) return {}
  const serviceTier = nonBlankString(options.serviceTier)
  const region = nonBlankString(options.region)
  const inferenceGeo = nonBlankString(options.inferenceGeo)
  const routedProviderId = nonBlankString(options.routedProviderId)
  const deploymentId = nonBlankString(options.deploymentId)
  const inferenceProfileId = nonBlankString(options.inferenceProfileId)
  const mode = nonBlankString(options.mode) ?? nonBlankString(options.speed)
  return {
    ...(serviceTier === undefined ? {} : { serviceTier }),
    ...(typeof options.batch === "boolean" ? { batch: options.batch } : {}),
    ...(region === undefined ? {} : { region }),
    ...(inferenceGeo === undefined ? {} : { inferenceGeo }),
    ...(routedProviderId === undefined ? {} : { routedProviderId }),
    ...(deploymentId === undefined ? {} : { deploymentId }),
    ...(inferenceProfileId === undefined ? {} : { inferenceProfileId }),
    ...(mode === undefined ? {} : { mode }),
    ...(Number.isSafeInteger(options.cacheWriteTtlSeconds) &&
    (options.cacheWriteTtlSeconds as number) > 0
      ? { cacheWriteTtlSeconds: options.cacheWriteTtlSeconds as number }
      : {}),
  }
}

/** Merge allowlisted provider-returned billing dimensions over the request snapshot. */
export function aiPricingContextFromAiSdkUsage(
  request: AiPricingContext,
  rawUsage: unknown
): AiPricingContext {
  if (!isUnknownRecord(rawUsage)) return { ...request }
  const serviceTier = findBillingString(rawUsage, ["service_tier", "serviceTier"])
  const inferenceGeo = findBillingString(rawUsage, ["inference_geo", "inferenceGeo"])
  const routedProviderId = findBillingString(rawUsage, ["routed_provider_id", "routedProviderId"])
  const mode = findBillingString(rawUsage, ["mode", "speed"])
  const oneHourCacheWriteTokens = findBillingNumber(rawUsage, ["ephemeral_1h_input_tokens"])
  const fiveMinuteCacheWriteTokens = findBillingNumber(rawUsage, ["ephemeral_5m_input_tokens"])
  const cacheWriteTtlSeconds =
    oneHourCacheWriteTokens !== undefined && oneHourCacheWriteTokens > 0
      ? 3_600
      : fiveMinuteCacheWriteTokens !== undefined && fiveMinuteCacheWriteTokens > 0
        ? 300
        : undefined
  return {
    ...request,
    ...(serviceTier === undefined ? {} : { serviceTier }),
    ...(inferenceGeo === undefined ? {} : { inferenceGeo }),
    ...(routedProviderId === undefined ? {} : { routedProviderId }),
    ...(mode === undefined ? {} : { mode }),
    ...(cacheWriteTtlSeconds === undefined ? {} : { cacheWriteTtlSeconds }),
  }
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

function providerOptionsKey(provider: string): string {
  const knownNamespaces: Readonly<Record<string, string>> = {
    "openai.responses": "openai",
    "openai.chat": "openai",
    "anthropic.messages": "anthropic",
    "google.generative-ai": "google",
    "amazon-bedrock.converse": "bedrock",
    "gateway.language-model": "gateway",
  }
  return knownNamespaces[provider] ?? provider
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nonBlankString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

function findBillingString(
  value: Record<string, unknown>,
  keys: readonly string[],
  depth = 0
): string | undefined {
  for (const key of keys) {
    const match = nonBlankString(value[key])
    if (match !== undefined) return match
  }
  if (depth >= 3) return undefined
  for (const child of Object.values(value)) {
    if (!isUnknownRecord(child)) continue
    const match = findBillingString(child, keys, depth + 1)
    if (match !== undefined) return match
  }
  return undefined
}

function findBillingNumber(
  value: Record<string, unknown>,
  keys: readonly string[],
  depth = 0
): number | undefined {
  for (const key of keys) {
    const match = value[key]
    if (typeof match === "number" && Number.isFinite(match) && match >= 0) return match
  }
  if (depth >= 3) return undefined
  for (const child of Object.values(value)) {
    if (!isUnknownRecord(child)) continue
    const match = findBillingNumber(child, keys, depth + 1)
    if (match !== undefined) return match
  }
  return undefined
}
