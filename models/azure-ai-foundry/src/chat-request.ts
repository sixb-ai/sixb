import {
  type JsonObject,
  type LanguageModelDefinition,
  type LanguageModelRequest,
  modelReasoningSupportIssue,
  UnsupportedModelFeatureError,
} from "@sixb/core/models"
import { chatInput } from "@sixb/model-protocols/chat"
import { prepareRequest } from "./request"
import { foundryOutputSchema } from "./structured-output"
import { PREFIX, positiveInteger } from "./util"

export interface ChatRequestOptions {
  readonly maxOutputTokens?: number
  readonly maxInputFileBytes?: number
  readonly request?: JsonObject
  /** Default: OpenAI-compatible. Select DeepSeek compatibility explicitly when required. */
  readonly profile?: "openai" | "deepseek"
  readonly systemRole?: "system" | "developer"
  /** Defaults to max_completion_tokens. Use max_tokens only for deployments requiring the older field. */
  readonly maxTokensParameter?: "max_completion_tokens" | "max_tokens"
  /** Request a final usage chunk (default true). Disable for offerings that reject stream_options. */
  readonly includeUsage?: boolean
  /** Default: omit. Opt in only when the deployed model requires reasoning for tool continuation. */
  readonly reasoningReplay?: "omit" | "tool-continuation"
}

const RESERVED = new Set([
  "model",
  "messages",
  "stream",
  "stream_options",
  "n",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "functions",
  "function_call",
  "response_format",
  "max_tokens",
  "max_completion_tokens",
  "reasoning_effort",
  "thinking",
  "reasoning",
  "modalities",
  "audio",
  "store",
])

export function validateChatOptions(options: ChatRequestOptions): void {
  positiveInteger(options.maxOutputTokens, "maxOutputTokens")
  positiveInteger(options.maxInputFileBytes, "maxInputFileBytes")
  for (const key of Object.keys(options.request ?? {}))
    if (RESERVED.has(key))
      throw new TypeError(`${PREFIX} Chat request option '${key}' is owned by the adapter.`)
  for (const [key, allowed] of [
    ["profile", ["openai", "deepseek"]],
    ["systemRole", ["system", "developer"]],
    ["maxTokensParameter", ["max_completion_tokens", "max_tokens"]],
    ["reasoningReplay", ["omit", "tool-continuation"]],
  ] as const) {
    if (options[key] !== undefined && !allowed.some((value) => value === options[key]))
      throw new TypeError(`${PREFIX} Invalid Chat ${key}.`)
  }
  if (options.includeUsage !== undefined && typeof options.includeUsage !== "boolean")
    throw new TypeError(`${PREFIX} includeUsage must be boolean.`)
}

export function foundryChatRequest(
  request: LanguageModelRequest,
  definition: LanguageModelDefinition,
  options: ChatRequestOptions,
  scope: string
): JsonObject {
  const max = prepareRequest(request, definition, options, scope)
  const profile = options.profile ?? "openai"
  if (profile !== "deepseek" && options.reasoningReplay === "tool-continuation")
    throw new UnsupportedModelFeatureError(
      `${PREFIX} Reasoning-content replay requires the DeepSeek Chat profile.`
    )
  const caps = definition.capabilities
  if (request.tools.length && caps.localTools !== true)
    throw new UnsupportedModelFeatureError(
      `${PREFIX} Configure localTools capability before using Chat tools.`
    )
  const reasoning = request.reasoning
  const explicitReasoning = reasoning !== undefined && reasoning !== "provider-default"
  if (explicitReasoning) {
    const issue = modelReasoningSupportIssue(caps.reasoning, reasoning)
    if (issue || caps.reasoning === undefined || typeof reasoning !== "string")
      throw new UnsupportedModelFeatureError(
        `${PREFIX} ${issue ?? "Chat reasoning requires declared named efforts; exact budgets are unsupported"}.`
      )
  }
  const schema = request.responseFormat && foundryOutputSchema(request.responseFormat.schema)
  if (
    request.responseFormat &&
    (profile === "deepseek" || caps.nativeStructuredOutput !== true || !schema)
  )
    throw new UnsupportedModelFeatureError(
      `${PREFIX} Chat structured output requires verified OpenAI-compatible strict-schema support. DeepSeek JSON mode is not strict schema decoding.`
    )
  const tools = request.tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      ...(profile === "openai"
        ? {
            strict:
              caps.nativeStructuredOutput === true &&
              foundryOutputSchema(tool.inputSchema) !== undefined,
          }
        : {}),
    },
  }))
  return {
    ...options.request,
    model: definition.modelId,
    messages: chatInput(request.messages, {
      providerId: definition.providerId,
      errorPrefix: PREFIX,
      systemRole: options.systemRole,
      reasoningReplay: options.reasoningReplay,
    }),
    stream: true,
    ...(options.includeUsage === false ? {} : { stream_options: { include_usage: true } }),
    ...(max === undefined ? {} : { [options.maxTokensParameter ?? "max_completion_tokens"]: max }),
    ...(explicitReasoning && typeof reasoning === "string" ? { reasoning_effort: reasoning } : {}),
    ...(tools.length
      ? {
          tools,
          tool_choice: "auto",
          ...(profile === "openai"
            ? {
                parallel_tool_calls:
                  !schema &&
                  !tools.some((tool) => tool.function.strict) &&
                  caps.parallelToolCalls === true,
              }
            : {}),
        }
      : {}),
    ...(schema && request.responseFormat
      ? {
          response_format: {
            type: "json_schema",
            json_schema: {
              name: request.responseFormat.name,
              schema,
              strict: true,
              ...(request.responseFormat.description
                ? { description: request.responseFormat.description }
                : {}),
            },
          },
        }
      : {}),
  }
}
