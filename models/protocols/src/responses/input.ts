import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type ModelMessage,
  type ModelToolOutput,
  type ProviderData,
} from "@sixb/core/models"
import { object, string } from "../json"

/** Serialize portable content and only the calling provider's ordered replay state. */
export function responsesInput(messages: readonly ModelMessage[], providerId: string): JsonValue[] {
  const input: JsonValue[] = []
  for (const message of messages) {
    if (message.role === "system") {
      input.push({ role: "system", content: [{ type: "input_text", text: message.content }] })
      continue
    }
    if (message.role === "user") {
      input.push({ role: "user", content: message.content.map(userPartToInput) })
      continue
    }
    if (message.role === "tool") {
      for (const part of message.content) {
        input.push({
          type: "function_call_output",
          call_id: part.toolCallId,
          output: toolOutputText(part.output),
        })
      }
      continue
    }
    const phases = new Map<string, string>()
    for (const part of message.content) {
      if (part.type !== "provider-state" || part.providerId !== providerId) continue
      const data = object(part.data)
      if (typeof data?.messageId === "string" && typeof data.phase === "string") {
        phases.set(data.messageId, data.phase)
      }
    }
    const assistantText: JsonValue[] = []
    let assistantMessageId: string | undefined
    const flushAssistantText = () => {
      if (assistantText.length === 0) return
      const phase = assistantMessageId === undefined ? undefined : phases.get(assistantMessageId)
      input.push({
        role: "assistant",
        content: assistantText.splice(0),
        ...(phase === undefined ? {} : { phase }),
      })
    }
    for (const part of message.content) {
      if (part.type === "provider-state") {
        if (part.providerId === providerId) {
          const data = object(part.data)
          const item = data?.item
          if (isJsonObject(item)) {
            flushAssistantText()
            input.push(item)
          }
        }
        continue
      }
      const raw = providerItem(part.providerData, providerId)
      if (raw) {
        flushAssistantText()
        input.push(raw)
        continue
      }
      if (part.type === "text") {
        const messageId = string(object(part.providerData?.[providerId])?.messageId) || undefined
        if (messageId !== assistantMessageId) flushAssistantText()
        assistantMessageId = messageId
        assistantText.push({ type: "output_text", text: part.text })
      } else if (part.type === "tool-call") {
        flushAssistantText()
        input.push({
          type: "function_call",
          call_id: part.toolCallId,
          name: part.toolName,
          arguments: JSON.stringify(part.input),
        })
      } else if (part.type === "tool-result" && part.providerExecuted) {
        flushAssistantText()
        input.push({
          type: "function_call_output",
          call_id: part.toolCallId,
          output: toolOutputText(part.output),
        })
      }
    }
    flushAssistantText()
  }
  return input
}

function userPartToInput(
  part: Extract<ModelMessage, { role: "user" }>["content"][number]
): JsonValue {
  if (part.type === "text") return { type: "input_text", text: part.text }
  if (part.mediaType.startsWith("image/")) {
    return { type: "input_image", image_url: part.data.toString(), detail: "auto" }
  }
  return {
    type: "input_file",
    ...(part.data.protocol === "data:"
      ? { file_data: part.data.toString() }
      : { file_url: part.data.toString() }),
    ...(part.filename === undefined ? {} : { filename: part.filename }),
  }
}

function providerItem(data: ProviderData | undefined, providerId: string): JsonObject | undefined {
  const provider = data?.[providerId]
  const wrapped = object(provider)
  return object(wrapped?.item)
}

function toolOutputText(output: ModelToolOutput): string {
  return output.type === "text" || output.type === "error-text"
    ? output.value
    : JSON.stringify(output.value)
}
