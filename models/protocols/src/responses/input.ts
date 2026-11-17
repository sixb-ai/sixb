import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type ModelMessage,
  type ModelToolOutput,
  type ProviderData,
} from "@sixb/core/models"
import { canonicalJsonStringify, object, string } from "../json"

/**
 * Serialize portable content and only the calling provider's ordered replay state. With `modelId`,
 * a native item another model produced, such as its encrypted reasoning, is left out: one provider
 * may front several models, and a model rejects another's reasoning. Its visible text and tool
 * calls still replay, portably. Items recorded without their model replay as before.
 */
export function responsesInput(
  messages: readonly ModelMessage[],
  providerId: string,
  modelId?: string
): JsonValue[] {
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
    const firstItem = input.length
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
          if (isJsonObject(item) && fromModel(data, modelId)) {
            flushAssistantText()
            input.push(item)
          }
        }
        continue
      }
      const raw = providerItem(part.providerData, providerId, modelId)
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
          arguments: canonicalJsonStringify(part.input),
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
    // A reasoning item only replays with the item it led to. An answer cut short by the output
    // limit, or cancelled, can end on reasoning alone, and Responses rejects it.
    while (input.length > firstItem && object(input.at(-1))?.type === "reasoning") input.pop()
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

function providerItem(
  data: ProviderData | undefined,
  providerId: string,
  modelId: string | undefined
): JsonObject | undefined {
  const provider = data?.[providerId]
  const wrapped = object(provider)
  return fromModel(wrapped, modelId) ? object(wrapped?.item) : undefined
}

/** Whether a replay item may go to `modelId`: one recorded without its model always may. */
function fromModel(data: JsonObject | undefined, modelId: string | undefined): boolean {
  const recorded = string(data?.modelId)
  return modelId === undefined || recorded === "" || recorded === modelId
}

function toolOutputText(output: ModelToolOutput): string {
  return output.type === "text" || output.type === "error-text"
    ? output.value
    : canonicalJsonStringify(output.value)
}
