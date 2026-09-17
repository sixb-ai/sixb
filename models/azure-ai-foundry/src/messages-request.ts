import {
  type JsonObject,
  type LanguageModelDefinition,
  type LanguageModelRequest,
  modelReasoningSupportIssue,
  UnsupportedModelFeatureError,
} from "@sixb/core/models"
import { messagesInput } from "@sixb/model-protocols/messages"
import { messagesOutputSchema } from "./messages-schema"
import type { AzureAIFoundryModelMetadata } from "./provider"
import { validateMessages } from "./request"
import { object, PREFIX, positiveInteger } from "./util"

export interface MessagesRequestOptions {
  readonly maxOutputTokens?: number
  readonly maxInputFileBytes?: number
  readonly request?: JsonObject
  /** Needed for named efforts on an offering absent from the documented model profiles. */
  readonly thinkingMode?: "adaptive" | "manual"
}

// Foundry model names, not deployment names. Reviewed 2026-09-16 against:
// https://learn.microsoft.com/azure/foundry/foundry-models/concepts/claude-models
const ADAPTIVE = new Set([
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-sonnet-4-6",
  "claude-sonnet-5",
  "claude-fable-5",
  "claude-fable-5-1",
  "claude-mythos-preview",
  "claude-mythos-5",
  "claude-mythos-5-1",
])
const MANUAL = new Set([
  "claude-opus-4-5",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-mythos-preview",
])
const AZURE_HOSTED = new Set([
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-4-5",
])
const RESERVED = new Set([
  "model",
  "messages",
  "system",
  "tools",
  "tool_choice",
  "stream",
  "max_tokens",
  "thinking",
  "output_config",
  "output_format",
  "disable_parallel_tool_use",
  "container",
  "mcp_servers",
  "context_management",
])

export function validateMessagesOptions(options: MessagesRequestOptions): void {
  positiveInteger(options.maxOutputTokens, "maxOutputTokens")
  positiveInteger(options.maxInputFileBytes, "maxInputFileBytes")
  if (options.thinkingMode !== undefined && !["adaptive", "manual"].includes(options.thinkingMode))
    throw new TypeError(`${PREFIX} thinkingMode must be adaptive or manual.`)
  for (const key of Object.keys(options.request ?? {}))
    if (RESERVED.has(key))
      throw new TypeError(`${PREFIX} Messages request option '${key}' is owned by the adapter.`)
  const cache = options.request?.cache_control
  if (cache !== undefined) {
    const value = object(cache)
    if (
      !value ||
      value.type !== "ephemeral" ||
      (value.ttl !== undefined && !["5m", "1h"].includes(String(value.ttl))) ||
      Object.keys(value).some((key) => !["type", "ttl"].includes(key))
    )
      throw new TypeError(
        `${PREFIX} cache_control must be ephemeral with an optional 5m or 1h ttl.`
      )
  }
}

export function validateClaudeOffering(
  metadata: AzureAIFoundryModelMetadata,
  entra: boolean
): void {
  if (metadata.publisher !== undefined && metadata.publisher.toLowerCase() !== "anthropic")
    throw new UnsupportedModelFeatureError(
      `${PREFIX} Native Messages requires an Anthropic deployment.`
    )
  const model = metadata.modelName ?? ""
  if (model.startsWith("claude-mythos-") && !entra)
    throw new UnsupportedModelFeatureError(
      `${PREFIX} Foundry Mythos requires Entra tokenProvider authentication.`
    )
  const versionHosting =
    metadata.modelVersion === "1"
      ? "anthropic"
      : metadata.modelVersion === "2"
        ? "azure"
        : undefined
  if (metadata.hosting && versionHosting && metadata.hosting !== versionHosting)
    throw new TypeError(
      `${PREFIX} Claude hosting conflicts with Foundry modelVersion (1: anthropic, 2: azure).`
    )
  const hosting = metadata.hosting ?? versionHosting
  if (hosting === "azure" && (ADAPTIVE.has(model) || MANUAL.has(model)) && !AZURE_HOSTED.has(model))
    throw new UnsupportedModelFeatureError(
      `${PREFIX} '${model}' is documented only for Anthropic-hosted Foundry deployments.`
    )
}

export function foundryMessagesRequest(
  request: LanguageModelRequest,
  definition: LanguageModelDefinition,
  options: MessagesRequestOptions,
  metadata: AzureAIFoundryModelMetadata,
  scope: string
): JsonObject {
  positiveInteger(request.maxOutputTokens, "maxOutputTokens")
  validateMessages(
    request.messages,
    definition,
    options.maxInputFileBytes ?? 20 * 1024 * 1024,
    scope,
    true
  )
  let conversation = false
  for (const message of request.messages) {
    if (message.role === "system" && conversation)
      throw new UnsupportedModelFeatureError(
        `${PREFIX} Messages system instructions must precede the conversation.`
      )
    if (message.role !== "system") conversation = true
  }
  const limits = [
    definition.maxOutputTokens,
    options.maxOutputTokens,
    request.maxOutputTokens,
  ].filter((n): n is number => n !== undefined)
  if (!limits.length)
    throw new TypeError(
      `${PREFIX} Native Messages requires maxOutputTokens in the definition, binding, or request.`
    )
  const max = Math.min(...limits)
  const caps = definition.capabilities
  if (request.tools.length && caps.localTools !== true)
    throw new UnsupportedModelFeatureError(
      `${PREFIX} Configure localTools capability before using Messages tools.`
    )
  const schema = request.responseFormat && messagesOutputSchema(request.responseFormat.schema)
  if (request.responseFormat && (caps.nativeStructuredOutput !== true || !schema))
    throw new UnsupportedModelFeatureError(
      `${PREFIX} Messages structured output requires a declared capability and a supported closed-object Claude schema.`
    )
  const thinking = reasoningRequest(request, definition, options, metadata.modelName ?? "", max)
  if (
    thinking.thinking &&
    object(thinking.thinking)?.type !== "disabled" &&
    ["temperature", "top_p", "top_k"].some((key) => options.request?.[key] !== undefined)
  )
    throw new UnsupportedModelFeatureError(
      `${PREFIX} Explicit sampling controls cannot be combined with Messages thinking.`
    )
  const mapped = messagesInput(request.messages, definition.providerId, PREFIX)
  const output: JsonObject = {
    ...(thinking.effort === undefined ? {} : { effort: thinking.effort }),
    ...(schema ? { format: { type: "json_schema", schema } } : {}),
  }
  return {
    ...options.request,
    model: definition.modelId,
    messages: mapped.messages,
    ...(mapped.system.length ? { system: mapped.system } : {}),
    stream: true,
    max_tokens: max,
    ...(thinking.thinking ? { thinking: thinking.thinking } : {}),
    ...(Object.keys(output).length ? { output_config: output } : {}),
    ...(request.tools.length
      ? {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
            ...(caps.nativeStructuredOutput === true && messagesOutputSchema(tool.inputSchema)
              ? { strict: true }
              : {}),
          })),
          tool_choice: { type: "auto", disable_parallel_tool_use: caps.parallelToolCalls !== true },
        }
      : {}),
  }
}

function reasoningRequest(
  request: LanguageModelRequest,
  definition: LanguageModelDefinition,
  options: MessagesRequestOptions,
  model: string,
  max: number
): { thinking?: JsonObject; effort?: string } {
  const reasoning = request.reasoning
  if (reasoning === undefined || reasoning === "provider-default") return {}
  const caps = definition.capabilities.reasoning
  const issue = modelReasoningSupportIssue(caps, reasoning)
  if (caps === undefined || issue)
    throw new UnsupportedModelFeatureError(
      `${PREFIX} ${issue ?? "Configure reasoning capabilities for this deployment"}.`
    )
  if (reasoning === "none") {
    if (model.startsWith("claude-fable-") || model.startsWith("claude-mythos-"))
      throw new UnsupportedModelFeatureError(
        `${PREFIX} This Claude offering cannot disable thinking.`
      )
    return { thinking: { type: "disabled" } }
  }
  if (typeof reasoning === "string") {
    if (
      reasoning === "minimal" ||
      options.thinkingMode === "manual" ||
      (!ADAPTIVE.has(model) && options.thinkingMode !== "adaptive") ||
      (MANUAL.has(model) && !ADAPTIVE.has(model))
    )
      throw new UnsupportedModelFeatureError(
        `${PREFIX} Named efforts require an adaptive-thinking Claude offering.`
      )
    if (
      (reasoning === "xhigh" && ["claude-opus-4-6", "claude-sonnet-4-6"].includes(model)) ||
      (reasoning === "max" &&
        (model.startsWith("claude-fable-") ||
          (model.startsWith("claude-mythos-") && model !== "claude-mythos-preview")))
    )
      throw new UnsupportedModelFeatureError(
        `${PREFIX} '${model}' does not support effort '${reasoning}'.`
      )
    return { thinking: { type: "adaptive" }, effort: reasoning }
  }
  if (options.thinkingMode === "adaptive" || (ADAPTIVE.has(model) && !MANUAL.has(model)))
    throw new UnsupportedModelFeatureError(
      `${PREFIX} This Claude offering only supports adaptive thinking, not manual budgets.`
    )
  if (reasoning.budgetTokens < 1024 || reasoning.budgetTokens >= max)
    throw new UnsupportedModelFeatureError(
      `${PREFIX} Messages reasoning budget must be at least 1024 and below maxOutputTokens (${max}).`
    )
  return { thinking: { type: "enabled", budget_tokens: reasoning.budgetTokens } }
}
