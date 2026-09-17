import {
  isJsonObject,
  type JsonObject,
  type ModelMessage,
  type ModelToolOutput,
  type ProviderData,
} from "@sixb/core/models"
import { object } from "../json"

const IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"]

/** Serialize portable messages and the calling provider's native signed/opaque blocks. */
export function messagesInput(
  messages: readonly ModelMessage[],
  providerId: string,
  errorPrefix: string
): { readonly system: JsonObject[]; readonly messages: JsonObject[] } {
  const system: JsonObject[] = []
  const mapped: JsonObject[] = []
  for (const message of messages) {
    if (message.role === "system") {
      system.push(
        providerBlock(message.providerData, providerId) ?? { type: "text", text: message.content }
      )
      continue
    }
    if (message.role === "user") {
      mapped.push({
        role: "user",
        content: message.content.map((part) => userBlock(part, providerId, errorPrefix)),
      })
      continue
    }
    if (message.role === "tool") {
      mapped.push({
        role: "user",
        content: message.content.map(
          (part) =>
            providerBlock(part.providerData, providerId) ?? {
              type: "tool_result",
              tool_use_id: part.toolCallId,
              content: toolOutputText(part.output),
              ...(part.output.type === "error-text" || part.output.type === "error-json"
                ? { is_error: true }
                : {}),
            }
        ),
      })
      continue
    }
    const content: JsonObject[] = []
    for (const part of message.content) {
      if (part.type === "provider-state") {
        if (part.providerId === providerId) {
          const block = object(part.data)?.block
          if (isJsonObject(block)) content.push(block)
        }
        continue
      }
      const raw = providerBlock(part.providerData, providerId)
      if (raw) {
        content.push(raw)
      } else if (part.type === "text") {
        content.push({ type: "text", text: part.text })
      } else if (part.type === "tool-call") {
        content.push({
          type: "tool_use",
          id: part.toolCallId,
          name: part.toolName,
          input: part.input,
        })
      } else if (part.type === "tool-result" && part.providerExecuted) {
        content.push({
          type: "tool_result",
          tool_use_id: part.toolCallId,
          content: toolOutputText(part.output),
        })
      }
      // Reasoning from another provider is not portable and must not be synthesized as thinking.
    }
    if (content.length > 0) mapped.push({ role: "assistant", content })
  }
  return { system, messages: coalesceRoles(mapped) }
}

function coalesceRoles(messages: readonly JsonObject[]): JsonObject[] {
  const result: JsonObject[] = []
  for (const message of messages) {
    const previous = result.at(-1)
    if (
      previous?.role === message.role &&
      Array.isArray(previous.content) &&
      Array.isArray(message.content)
    ) {
      previous.content = [...previous.content, ...message.content]
    } else {
      result.push(message)
    }
  }
  return result
}

function userBlock(
  part: Extract<ModelMessage, { role: "user" }>["content"][number],
  providerId: string,
  errorPrefix: string
): JsonObject {
  const raw = providerBlock(part.providerData, providerId)
  if (raw) return raw
  if (part.type === "text") return { type: "text", text: part.text }
  if (IMAGE_MEDIA_TYPES.includes(part.mediaType)) {
    return { type: "image", source: mediaSource(part.data, part.mediaType, errorPrefix) }
  }
  if (part.mediaType === "application/pdf") {
    return { type: "document", source: mediaSource(part.data, part.mediaType, errorPrefix) }
  }
  throw new TypeError(`${errorPrefix} Unsupported file media type '${part.mediaType}'.`)
}

function mediaSource(data: URL, mediaType: string, errorPrefix: string): JsonObject {
  if (data.protocol !== "data:") return { type: "url", url: data.toString() }
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(data.toString())
  if (!match) throw new TypeError(`${errorPrefix} File data URLs must use base64 encoding.`)
  const [, encodedMediaType = "", encodedData = ""] = match
  if (encodedMediaType !== mediaType) {
    throw new TypeError(
      `${errorPrefix} File data URL media type '${encodedMediaType}' does not match '${mediaType}'.`
    )
  }
  return { type: "base64", media_type: mediaType, data: encodedData }
}

function providerBlock(data: ProviderData | undefined, providerId: string): JsonObject | undefined {
  return object(object(data?.[providerId])?.block)
}

function toolOutputText(output: ModelToolOutput): string {
  return output.type === "text" || output.type === "error-text"
    ? output.value
    : JSON.stringify(output.value)
}
