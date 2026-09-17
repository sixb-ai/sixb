import {
  isJsonObject,
  type JsonObject,
  type LanguageModelDefinition,
  type LanguageModelRequest,
  type ModelMessage,
  modelReasoningSupportIssue,
  UnsupportedModelFeatureError,
} from "@sixb/core/models"
import { responsesInput } from "@sixb/model-protocols/responses"
import { foundryOutputSchema } from "./structured-output"
import { object, PREFIX, positiveInteger } from "./util"

export interface RequestOptions {
  readonly maxOutputTokens?: number
  readonly request?: JsonObject
  readonly reasoningSummary?: "auto" | "concise" | "detailed"
  /** Defaults to true. Disable only for deployments that do not support encrypted replay. */
  readonly encryptedReasoning?: boolean
  /** Aggregate decoded inline image/PDF bytes; defaults to 20 MiB. */
  readonly maxInputFileBytes?: number
}

const RESERVED = new Set([
  "model",
  "input",
  "instructions",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "stream",
  "store",
  "background",
  "conversation",
  "previous_response_id",
  "include",
  "reasoning",
  "text",
  "max_output_tokens",
  "truncation",
])

export function validateOptions(options: RequestOptions): void {
  positiveInteger(options.maxOutputTokens, "maxOutputTokens")
  positiveInteger(options.maxInputFileBytes, "maxInputFileBytes")
  for (const key of Object.keys(options.request ?? {})) {
    if (RESERVED.has(key))
      throw new TypeError(`${PREFIX} Request option '${key}' is owned by the adapter.`)
  }
  if (options.encryptedReasoning !== undefined && typeof options.encryptedReasoning !== "boolean")
    throw new TypeError(`${PREFIX} encryptedReasoning must be boolean.`)
  if (
    options.reasoningSummary !== undefined &&
    !["auto", "concise", "detailed"].includes(options.reasoningSummary)
  )
    throw new TypeError(`${PREFIX} Invalid reasoningSummary.`)
}

export function responsesRequest(
  request: LanguageModelRequest,
  definition: LanguageModelDefinition,
  options: RequestOptions,
  project: boolean,
  scope: string
): JsonObject {
  const max = prepareRequest(request, definition, options, scope)
  const input = responsesInput(request.messages, definition.providerId).map((item) => {
    if (!isJsonObject(item)) return item
    const content = Array.isArray(item.content)
      ? item.content.map((part) => {
          if (isJsonObject(part) && part.type === "input_file" && part.file_data && !part.filename)
            return { ...part, filename: "document.pdf" }
          return part
        })
      : undefined
    return {
      ...item,
      ...(content ? { content } : {}),
      ...(project && item.role !== undefined ? { type: "message" } : {}),
    }
  })
  const caps = definition.capabilities
  if (request.tools.length && caps.localTools !== true)
    throw new UnsupportedModelFeatureError(
      `${PREFIX} Configure localTools capability for this deployment before using tools.`
    )
  const schema = request.responseFormat && foundryOutputSchema(request.responseFormat.schema)
  if (request.responseFormat && (caps.nativeStructuredOutput !== true || !schema)) {
    throw new UnsupportedModelFeatureError(
      `${PREFIX} Structured output requires a declared capability and an Azure-compatible strict schema (100 properties, five levels, closed objects, all properties required).`
    )
  }
  const reasoning = request.reasoning
  if (reasoning !== undefined && reasoning !== "provider-default") {
    const issue = modelReasoningSupportIssue(caps.reasoning, reasoning)
    if (typeof reasoning !== "string" || caps.reasoning === undefined || issue) {
      throw new UnsupportedModelFeatureError(
        `${PREFIX} ${issue ?? "Responses reasoning requires declared named efforts; exact token budgets are unsupported"}.`
      )
    }
  }
  if (options.reasoningSummary && (!caps.reasoning || typeof caps.reasoning !== "object"))
    throw new UnsupportedModelFeatureError(
      `${PREFIX} Reasoning summaries require a declared reasoning capability.`
    )
  const tools = request.tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict:
      caps.nativeStructuredOutput === true && foundryOutputSchema(tool.inputSchema) !== undefined,
  }))
  return {
    ...options.request,
    model: definition.modelId,
    input,
    stream: true,
    store: false,
    ...(options.encryptedReasoning === false ? {} : { include: ["reasoning.encrypted_content"] }),
    ...(max === undefined ? {} : { max_output_tokens: max }),
    ...(tools.length
      ? {
          tools,
          tool_choice: "auto",
          parallel_tool_calls:
            !schema && !tools.some((t) => t.strict) && caps.parallelToolCalls === true,
        }
      : {}),
    ...((reasoning !== undefined && reasoning !== "provider-default") || options.reasoningSummary
      ? {
          reasoning: {
            ...(reasoning === undefined || reasoning === "provider-default"
              ? {}
              : { effort: reasoning }),
            ...(options.reasoningSummary ? { summary: options.reasoningSummary } : {}),
          },
        }
      : {}),
    ...(schema && request.responseFormat
      ? {
          text: {
            format: {
              type: "json_schema",
              name: request.responseFormat.name,
              schema,
              strict: true,
              ...(request.responseFormat.description === undefined
                ? {}
                : { description: request.responseFormat.description }),
            },
          },
        }
      : {}),
  }
}

export function prepareRequest(
  request: LanguageModelRequest,
  definition: LanguageModelDefinition,
  options: { readonly maxOutputTokens?: number; readonly maxInputFileBytes?: number },
  scope: string,
  remotePdf = false
): number | undefined {
  positiveInteger(request.maxOutputTokens, "maxOutputTokens")
  validateMessages(
    request.messages,
    definition,
    options.maxInputFileBytes ?? 20 * 1024 * 1024,
    scope,
    remotePdf
  )
  const limits = [
    definition.maxOutputTokens,
    options.maxOutputTokens,
    request.maxOutputTokens,
  ].filter((n): n is number => n !== undefined)
  return limits.length ? Math.min(...limits) : undefined
}

export function validateMessages(
  messages: readonly ModelMessage[],
  definition: LanguageModelDefinition,
  budget: number,
  scope: string,
  remotePdf = false
): void {
  let bytes = 0
  for (const message of messages) {
    if (message.role === "system") {
      checkScope(message.providerData?.[definition.providerId], scope)
      continue
    }
    for (const part of message.content) {
      if (part.type === "provider-state") {
        if (part.providerId === definition.providerId) checkScope(part.data, scope)
        continue
      }
      checkScope(part.providerData?.[definition.providerId], scope)
      if (part.type !== "file") continue
      const allowed = definition.capabilities.inputMediaTypes
      const media = part.mediaType
      if (
        !["application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif"].includes(
          media
        ) ||
        !(
          allowed === "any" ||
          allowed?.some(
            (type) => type === media || (type === "image/*" && media.startsWith("image/"))
          )
        )
      ) {
        throw new UnsupportedModelFeatureError(
          `${PREFIX} Input media '${media}' is not supported by this deployment's configured capabilities.`
        )
      }
      if (part.data.username || part.data.password)
        throw new TypeError(`${PREFIX} File URLs must not contain credentials.`)
      if (part.data.protocol !== "data:") {
        if (
          (!remotePdf && media === "application/pdf") ||
          !["https:", "http:"].includes(part.data.protocol)
        )
          throw new UnsupportedModelFeatureError(
            `${PREFIX} ${remotePdf ? "Use inline base64 or HTTP(S) images/PDFs." : "Use an inline base64 PDF or an HTTP(S)/base64 image."}`
          )
        continue
      }
      const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(part.data.href)
      if (!match || match[1] !== media || !match[2] || match[2].length % 4 !== 0)
        throw new TypeError(
          `${PREFIX} File data must be canonical base64 with a matching media type.`
        )
      const data = match[2]
      bytes += (data.length / 4) * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0)
      if (bytes > budget)
        throw new RangeError(`${PREFIX} Inline files exceed maxInputFileBytes (${budget}).`)
      if (Buffer.from(data, "base64").toString("base64") !== data)
        throw new TypeError(`${PREFIX} File data must use canonical base64.`)
    }
  }
}

function checkScope(data: unknown, scope: string): void {
  if (data !== undefined && object(data)?.scope !== scope) {
    throw new UnsupportedModelFeatureError(
      `${PREFIX} Replay state belongs to a different endpoint, deployment, or protocol.`
    )
  }
}
